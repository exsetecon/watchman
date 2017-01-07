// Modules
const FS = require('fs');
const PATH = require('path');
const ES = require('elasticsearch');
const CONFIG = require('./config.json');
var ES_CLIENT = new ES.Client({
	host: CONFIG.es_host ? CONFIG.es_host : "localhost:9200",
	log: CONFIG.es_log_level ? CONFIG.es_log_level : "info"
});

// Default Locations
const DIR = {
	RULES: PATH.join(__dirname, "rules/"),
    ALERTS: PATH.join(__dirname, "alerts/"),
};

// Load All Rules
var rule_dirs = FS.readdirSync(DIR.RULES);
var RULE_DATA = {};

// Load All Alert APIs
var alert_list = FS.readdirSync(DIR.ALERTS);
var ALERT_API = {};

if (alert_list.length > 0) {
	alert_list.forEach(function(myalert){
        var alert_file = PATH.join(DIR.ALERTS, myalert);
        if (FS.statSync(alert_file).isFile()) {
            try {
                var alert_file_obj = require(alert_file)(null);
                if (typeof alert_file_obj.name !== "undefined") {
                    ALERT_API[alert_file_obj.name] = alert_file_obj;
                    console.log("*** Initializing Alert Plugin '"+alert_file_obj.name+"'...");
                    ALERT_API[alert_file_obj.name].init();
                }
                else {
                    console.log("## Unknown Alert API: ", alert_file);
                }
            }
            catch(err) {
                console.log("## Error Loading Alert API: " + String(err));
            }
        }
        else {
            console.log("## " + alert_file + " is not a Valid API file!");
        }
    });
}
else {
    console.log("## No Alert APIs found!");
}

// Get Expression Matches
var getExprMatches = function(expr){
    return expr.match(/\$\{([^\{\}]*)\}/gi);
};

// Render Alert Text
var renderAlertText = function(template, es){
	var matches = getExprMatches(template);
    if (matches) {
        matches.forEach(function(match){
            var match_val = eval(match.replace(/\$\{([^\}]*)\}/gmi, "$1"));
            template = template.replace(match, match_val);
        });
    }
	return template;
};

// Replace Parameters
var replaceParams = function(data){
	var PARAM = {
		CURRENT_TIME_MS: new Date().getTime()
	};
	var matches = getExprMatches(data);
    if (matches) {
        matches.forEach(function(match){
            // Replace Friendly Time values
            match_val = match.replace(/([0-9]+)seconds?/gmi, "$1*1000");		// 1 sec = 1000ms
            match_val = match_val.replace(/([0-9]+)minutes?/gmi, "$1*60*1000");	// 1 minute = 60sec x 1000ms
            match_val = match_val.replace(/([0-9]+)hours?/gmi, "$1*60*60*1000");	// 1 hour = 60min x 60sec x 1000ms
            match_val = match_val.replace(/([0-9]+)days?/gmi, "$1*24*60*60*1000");	// 1 day = 24hour x 60min x 60sec x 1000ms
            var param_val = eval(match_val.replace(/\$\{([^\}]*)\}/gmi, "$1"));
            data = data.replace(match, param_val);
        });
    }
    //console.log("Data is: ", data);
	return data;
};

// Build ElasticSearch Response Variable Expression
var makeSearchResponseExpr = function(expr) {
    return expr.replace(/\$\{es\.([^\{\}]*)\}/gi, "es_response.$1");
};

// Trigger Alert
var triggerAlert = function(rule_data, result){
    if (ALERT_API.hasOwnProperty(rule_data["alert"]["type"])) {
        var alert_text = renderAlertText(rule_data["alert"]["text"], result);
        ALERT_API[rule_data["alert"]["type"]].sendAlert(rule_data["alert"]["config"], alert_text, function(err){
            if (!err) {
                console.log(">> "+rule_data["name"]+": Alert Sent");
            }
            else {
                console.log("## Error while sending Alert via "+rule_data["alert"]["type"]+": ", String(err));
            }
        });
    }
    else {
        console.log("## Unknown Alert Type '"+rule_data["alert"]["type"]+"'. Cannot send Alert!")
    }
    //console.log("! ! ! ALERT ! ! !");
    //console.log("TRIGGER DATA: ", JSON.stringify(rule_data));
};

// Query Elastic
var doSearch = function(index, query, success_callback, error_callback){
	ES_CLIENT.search({
		index: index,
		body: query
	}).then(success_callback, error_callback);
};

// Add Rule to Query after specific Intervals of Time
var addRuleTimer = function(rule_data){
	var time_delay_ms = rule_data["config"]["run_every"] * 1000;

	var fun_success = function(es_response) {
        //console.log("Got successfull Response from ES!", JSON.stringify(es_response));
		// Try Parsing the Alert Expression on Data
        var expr_val = false;
        var i=0;
        var array_type_matches = [];
		try {
            // Check Expression for Array Values
            if (rule_data["config"]["alert"]["expr_parsed"].indexOf("[i]") != -1) {
                try {
                    while(true) {
                        //console.log("Value of i: "+i)
                        var new_expr = rule_data["config"]["alert"]["expr_parsed"].replace(/\[i\]/gi, "["+i+"]");
                        //console.log("Check Expr: ", new_expr);
                        if (eval(new_expr)) {
                            array_type_matches.push(i);
                            //console.log("Setting expr_loop as ", expr_loop_i);
                            expr_val = true;
                        }
                        i++;
                    }
                }
                catch(err) {
                    // Nothing here
                    //console.log("while loop breaks on i="+i);
                }
            }
            else {
                expr_val = eval(rule_data["config"]["alert"]["expr_parsed"]);
            }
			if(expr_val) {
                // Recursively call Rule again and again after an Interval of Time
                addRuleTimer(rule_data);
                // If there is a Loop in Expression
                if (array_type_matches.length > 0) {
                    console.log(">> Result: "+rule_data["config"]["name"]+": "+array_type_matches.length+" Matches.");
                    array_type_matches.forEach(function(i_pos){
                        //console.log("Value of i: "+i_pos)
                        var tmp_rule_config = JSON.parse(JSON.stringify(rule_data["config"]));
                        tmp_rule_config["alert"]["text"] = tmp_rule_config["alert"]["text"].replace(/\[i\]/gi, "["+i_pos+"]");
                        triggerAlert(tmp_rule_config, es_response);
                    });
                }
                else {
                    console.log(">> Result: "+rule_data["config"]["name"]+": 1 Match.");
                    triggerAlert(rule_data["config"], es_response);
                }
			}
			else {
                console.log(">> Result: "+rule_data["config"]["name"]+": No Matches! No Alert!");
                addRuleTimer(rule_data);
			}
            console.log(">> "+rule_data["config"]["name"]+": Sleeping for " + rule_data["config"]["run_every"] + " seconds...");
		}
		catch(alert_expr_err) {
			console.log("## Cannot Parse Alert Expression", alert_expr_err);
		}
	};
	var fun_error = function (err) {
		console.trace("## ElasticSearch Error: ", err.message);
		// Recursively call Rule again and again after an Interval of Time
		addRuleTimer(rule_data);
		console.log(">> Sleeping for " + rule_data["config"]["run_every"] + " seconds...");
	};

	setTimeout(function(){
		console.log(">> Querying Rule: " + rule_data["config"]["name"]);
		//console.log(">> Index : " + rule_data["config"]["index"]);
        //console.log("ES Query: ", JSON.stringify(rule_data["query"]));
		var es_query = JSON.parse(replaceParams(rule_data["query"]));
        doSearch(rule_data["config"]["index"], es_query, fun_success, fun_error);
	}, time_delay_ms);
};

// Main
if (rule_dirs.length > 0) {
	rule_dirs.forEach(function(rule_d){
        var rule_folder = PATH.join(DIR.RULES, rule_d);
        if (FS.statSync(rule_folder).isDirectory()) {
            RULE_DATA[rule_d] = {};
            // For each Rule Directory, fetch the Rule Details
            var rule_details = FS.readdirSync(rule_folder);
            // if all required files are present ?
            if (rule_details.indexOf("config.json") != -1 && rule_details.indexOf("query.json") != -1) {
                // All Rule Files there... Proceed..
                var config_data = FS.readFileSync(PATH.join(DIR.RULES, rule_d, "config.json"), "utf8");
                var query_data = FS.readFileSync(PATH.join(DIR.RULES, rule_d, "query.json"), "utf8");
                RULE_DATA[rule_d]["config"] = JSON.parse(config_data);
                RULE_DATA[rule_d]["query"] = query_data;
            }
            else {
                delete RULE_CONFIG[rule_d];
                console.log("## Not all Files inside "+rule_d);
            }
        }
        else {
            console.log("## "+rule_folder+" is not a Valid Rule Directory.");
        }
	});

	var timers = [];
	// Start Querying for all Rules
	for (var rule in RULE_DATA) {
		if (RULE_DATA.hasOwnProperty(rule)) {
            if (ALERT_API.hasOwnProperty(RULE_DATA[rule]["config"]["alert"]["type"])) {
                // Check for Required Fields
                var req_fields_provided = true;
                if (ALERT_API[RULE_DATA[rule]["config"]["alert"]["type"]].required && typeof ALERT_API[RULE_DATA[rule]["config"]["alert"]["type"]].required == "object") {
                    ALERT_API[RULE_DATA[rule]["config"]["alert"]["type"]].required.forEach(function(field){
                        if (!RULE_DATA[rule]["config"]["alert"]["config"].hasOwnProperty(field) || !RULE_DATA[rule]["config"]["alert"]["config"][field]) {
                            req_fields_provided = false;
                            console.log("## Field '"+field+"' missing from '"+RULE_DATA[rule]["config"]["name"]+"' Config.")
                        }
                    });
                }

                if (req_fields_provided) {
                    console.log("*** Adding Rule: " + RULE_DATA[rule]["config"]["name"]);
                    // Make Alert Expression
                    RULE_DATA[rule]["config"]["alert"]["expr_parsed"] = makeSearchResponseExpr(RULE_DATA[rule]["config"]["alert"]["expr"]);
                    // Add Rule
                    addRuleTimer(RULE_DATA[rule]);
                    console.log(">> Sleeping for " + RULE_DATA[rule]["config"]["run_every"] + " seconds...");
                }
            }
            else {
                console.log("## Alert Type '"+RULE_DATA[rule]["config"]["alert"]["type"]+"' not found!");
            }
		}
	}
}
else {
	console.log("No Rules found!");
}