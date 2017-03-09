// Modules
const FS = require('fs');
const PATH = require('path');
const ES = require('elasticsearch');
const md5 = require('md5');

// Default Locations
const DIR = {
	ROOT: PATH.join(__dirname),
	RULES: PATH.join(__dirname, "rules/"),
	ALERTS: PATH.join(__dirname, "alerts/")
};
const FILES = {
	CONFIG: PATH.join(DIR.ROOT, "config.json"),
	TRIGGER_SWITCH: PATH.join(DIR.ROOT, "trigger_switch_state.json")
};

const CONFIG = require(FILES.CONFIG);
var ES_CLIENT = new ES.Client({
	host: CONFIG.es_host ? CONFIG.es_host : "localhost:9200",
	log: CONFIG.es_log_level ? CONFIG.es_log_level : "info"
});

const CONSTANTS = {
	RULE_TYPE: {
		STATEFUL: "stateful",
		STATELESS: "stateless"
	},
	ALERT_TYPE: {
		START: "alert_start",
		END: "alert_end"
	}
};

// Load All Rules
var rule_dirs = FS.readdirSync(DIR.RULES);
var RULE_DATA = {};

// Load All Alert APIs
var alert_list = FS.readdirSync(DIR.ALERTS);
var ALERT_API = {};

// Trigger Switch
var TRIGGER_SWITCH = {};

// Polling Counter
var POLL_COUNTER = {};

// Load Previous Trigger Switches States from File
try {
	if (FS.statSync(FILES.TRIGGER_SWITCH).isFile()) {
		TRIGGER_SWITCH = require(FILES.TRIGGER_SWITCH);
		if (typeof TRIGGER_SWITCH != "object" || Object.keys(TRIGGER_SWITCH).length == 0) {
			TRIGGER_SWITCH = {};
		}
	}
} catch(err) {
	console.log("## Error while loading previous Trigger Switch State: " + String(err));
}

// Function to Save Trigger Switches State in a File on Disk
var saveTriggers = function(){
	FS.writeFileSync(FILES.TRIGGER_SWITCH, JSON.stringify(TRIGGER_SWITCH));
};

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
				} else {
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
var renderAlertText = function(template, es, tmp, P){
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
			match_val = match.replace(/([0-9]+)seconds?/gmi, "$1*1000");				// 1 sec = 1000ms
			match_val = match_val.replace(/([0-9]+)minutes?/gmi, "$1*60*1000"); // 1 minute = 60sec x 1000ms
			match_val = match_val.replace(/([0-9]+)hours?/gmi, "$1*60*60*1000");		// 1 hour = 60min x 60sec x 1000ms
			match_val = match_val.replace(/([0-9]+)days?/gmi, "$1*24*60*60*1000");	  // 1 day = 24hour x 60min x 60sec x 1000ms
			var param_val = eval(match_val.replace(/\$\{([^\}]*)\}/gmi, "$1"));
			data = data.replace(match, param_val);
		});
	}
	//console.log("Data is: ", data);
	return data;
};

var getUniqueAlertId = function(rule_name, alert_id) {
	return md5(rule_name + (alert_id ? alert_id : ""));
};

// Build ElasticSearch Response Variable Expression
var makeSearchResponseExpr = function(expr) {
	expr = expr.replace(/\${ALERT_ID}/gmi, "alert_id");
	expr = expr.replace(/\$\{P\.([^\{\}]*)\}/gmi, "rule_params.$1");
	expr = expr.replace(/\$\{P\[([^\{\}]*)\]\}/gmi, "rule_params[$1]");
	expr = expr.replace(/\$\{tmp\.([^\{\}]*)\}/gmi, "temp_data.$1");
	expr = expr.replace(/\$\{tmp\[([^\{\}]*)\]\}/gmi, "temp_data[$1]");
	expr = expr.replace(/\$\{es\.([^\{\}]*)\}/gmi, "es_response.$1");
	expr = expr.replace(/\$\{es\[([^\{\}]*)\]\}/gmi, "es_response[$1]");
	return expr;
};

var sendAlerts = function(unique_alert_id, alert_type, rule_data, x, alert_config, alert_text){
	var retry_count = 0;

	if (alert_type == CONSTANTS.ALERT_TYPE.START) {
		TRIGGER_SWITCH[unique_alert_id] = true;
	} else {
		TRIGGER_SWITCH[unique_alert_id] = false;
	}
	// Save Trigger State into File on Disk
	saveTriggers();

	var sendNow = function(){
		ALERT_API[rule_data[alert_type][x]["type"]].sendAlert(alert_config, alert_text, function(err){
			if (!err) {
				console.log(">> "+rule_data["name"]+": Alert Sent via: "+rule_data[alert_type][x]["type"]);
			} else {
				console.log("## Error while sending Alert via "+rule_data[alert_type][x]["type"]+": ", String(err));
				if (retry_count < 2) {
					retry_count++;
					console.log("## Retrying Sending Alert via "+rule_data[alert_type][x]["type"]);
					sendNow();
				} else {
					console.log("## Failed Sending Alert via "+rule_data[alert_type][x]["type"]);
				}
			}
		});
	};
	sendNow();
};

// Trigger Alert
var triggerAlert = function(trigger_satisfy, alert_id, rule_data, result, temp_data, rule_params){
	// Generate a Unique Hash of the Alert which will act as an ID for a specific Alert
	var unique_alert_id = getUniqueAlertId(rule_data["dir_name"], alert_id);

	var callAlert = function(alerts_list, type) {
		for (var x=0; x < alerts_list.length; x++) {
			if (ALERT_API.hasOwnProperty(alerts_list[x]["type"])) {
				var alert_text = renderAlertText(alerts_list[x]["text"], result, temp_data, rule_params);
				var alert_config = JSON.parse(renderAlertText(JSON.stringify(alerts_list[x]["config"]), result, temp_data, rule_params));
				sendAlerts(unique_alert_id, type, rule_data, x, alert_config, alert_text);
			}
			else {
				console.log("## Unknown Alert Start Type '"+alerts_list[x]["type"]+"'. Cannot send Alert!")
			}
		}
	};
	
	// Trigger Condition satisfies ?
	if (trigger_satisfy) {
		if (TRIGGER_SWITCH[unique_alert_id] == false) {
			if (POLL_COUNTER[unique_alert_id].up >= rule_data["poll_count"]-1) {
				// FALSE ---> TRUE
				// Issue Started
				console.log("## Issue Started...");
				callAlert(rule_data["alert_start"], CONSTANTS.ALERT_TYPE.START);
				POLL_COUNTER[unique_alert_id].down = 0;
				// Reset the Counter in case of Stateless Rule
				if (rule_data["type"] == CONSTANTS.RULE_TYPE.STATELESS) {
					POLL_COUNTER[unique_alert_id].up = 0;
				}
			} else {
				// Incrementing the Poll Counter
				console.log("## Issue Started Count is "+POLL_COUNTER[unique_alert_id].up+". Incrementing...");
				POLL_COUNTER[unique_alert_id].up++;
			}
		} else {
			if (rule_data["type"] == CONSTANTS.RULE_TYPE.STATELESS) {
				if (POLL_COUNTER[unique_alert_id].up >= rule_data["poll_count"]-1) {
					// TRUE ---> TRUE
					// Issue still ongoing
					callAlert(rule_data["alert_start"], CONSTANTS.ALERT_TYPE.START);
					// Reset Poll Counter
					POLL_COUNTER[unique_alert_id].up = 0;
				} else {
					// Incrementing the Poll Counter
					console.log("## Issue Started Count is "+POLL_COUNTER[unique_alert_id].up+". Incrementing...");
					POLL_COUNTER[unique_alert_id].up++;
				}
			}
			POLL_COUNTER[unique_alert_id].down = 0;
			console.log("## Issue still going...");
		}
	} else {
		if (TRIGGER_SWITCH[unique_alert_id] == true) {
			if (POLL_COUNTER[unique_alert_id].down >= rule_data["poll_count"]-1) {
				// TRUE ---> FALSE
				// Issue Resolved
				console.log("## Issue Resolved...");
				callAlert(rule_data["alert_end"], CONSTANTS.ALERT_TYPE.END);
				POLL_COUNTER[unique_alert_id].up = 0;
			} else {
				// Incrementing the Poll Counter
				console.log("## Issue Resolved Count is "+POLL_COUNTER[unique_alert_id].down+". Incrementing...");
				POLL_COUNTER[unique_alert_id].down++;
			}
		} else {
			// FALSE ---> FALSE
			// No Issue since the Last Trigger
			//console.log("## No Issue found...");
			POLL_COUNTER[unique_alert_id].up = 0;
		}
	}
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
		var alert_id = null;
		var alert_id_array = [];
		var temp_data = {};
		var temp_data_array = [];
		var rule_params = rule_data["config"]["params"] ? rule_data["config"]["params"] : {};
		var i=0;
		var true_matches = [];
		var false_matches = [];
//		console.log("Expr parsed: ", rule_data["config"]["expr_parsed"]);
		try {
			// Check Expression for Array Values
			if (rule_data["config"]["expr_parsed"].indexOf("[i]") != -1) {
				try {
					while(true) {
						var new_expr = rule_data["config"]["expr_parsed"].replace(/\[i\]/gmi, "["+i+"]");
						var result = eval(new_expr);
						var unique_alert_id = getUniqueAlertId(rule_data["config"]["dir_name"], alert_id);
						// Set Switch as FALSE by default
						if (!TRIGGER_SWITCH.hasOwnProperty(unique_alert_id)) {
							TRIGGER_SWITCH[unique_alert_id] = false;
						}
						// Initialize Polling Counters to 0 by default
						if (!POLL_COUNTER.hasOwnProperty(unique_alert_id)) {
							POLL_COUNTER[unique_alert_id] = {	up: 0, down: 0	};
						}
						alert_id_array.push(alert_id);
						alert_id = null;
						temp_data_array[i] = temp_data;
						temp_data = {};
						if (result) {
							true_matches.push(i);
						} else if (result == false) {
							false_matches.push(i);
						} else if (result == null) {
							// Continue
						} else {
							console.log("!! Got Undefined Result from evaluating Expression for Rule: "+rule_data["config"]["name"]);
							break;
						}
						i++;
					}
				}
				catch(err) {
					// Nothing here
					console.log("Catching Error: ", String(err));
					//console.log("while loop breaks on i="+i);
				}
			}

			// Array based Rules
			if (true_matches.length > 0 || false_matches.length > 0) {
				// Trigger Satisfying Alerts
				true_matches.forEach(function(i_pos){
					var tmp_rule_config = JSON.parse(JSON.stringify(rule_data["config"]));
					for (var z=0; z < tmp_rule_config["alert_start"].length; z++) {
						tmp_rule_config["alert_start"][z]["text"] = tmp_rule_config["alert_start"][z]["text"].replace(/\[i\]/gmi, "["+i_pos+"]");
					}
					triggerAlert(true, alert_id_array[i_pos], tmp_rule_config, es_response, temp_data_array[i_pos], rule_params);
				});
				// Trigger Non-Satisfying Alerts
				false_matches.forEach(function(i_pos){
					var tmp_rule_config = JSON.parse(JSON.stringify(rule_data["config"]));
					for (var z=0; z < tmp_rule_config["alert_end"].length; z++) {
						tmp_rule_config["alert_end"][z]["text"] = tmp_rule_config["alert_end"][z]["text"].replace(/\[i\]/gmi, "["+i_pos+"]");
					}
					triggerAlert(false, alert_id_array[i_pos], tmp_rule_config, es_response, temp_data_array[i_pos], rule_params);
				});
			} else if (rule_data["config"]["expr_parsed"].indexOf("[i]") == -1) {
				// Non-Array based Rules
				rule_result = eval(rule_data["config"]["expr_parsed"]);
				var unique_alert_id = getUniqueAlertId(rule_data["config"]["dir_name"], alert_id);
				// Set Switch as FALSE by default
				if (!TRIGGER_SWITCH.hasOwnProperty(unique_alert_id)) {
					TRIGGER_SWITCH[unique_alert_id] = false;
				}
				// Initialize Polling Counters to 0 by default
				if (!POLL_COUNTER.hasOwnProperty(unique_alert_id)) {
					POLL_COUNTER[unique_alert_id] = {	up: 0, down: 0	};
				}
				if (rule_result) {
					triggerAlert(true, alert_id, rule_data["config"], es_response, temp_data, rule_params);
				} else {
					triggerAlert(false, alert_id, rule_data["config"], es_response, temp_data, rule_params);
				}
			}

			// Recursively call Rule again and again after an Interval of Time
			addRuleTimer(rule_data);
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
				var expr_data = FS.readFileSync(PATH.join(DIR.RULES, rule_d, "expression.js"), "utf8");
				RULE_DATA[rule_d]["config"] = JSON.parse(config_data);
				// Default Rule Type
				if (!RULE_DATA[rule_d]["config"]["type"] || ([CONSTANTS.RULE_TYPE.STATELESS, CONSTANTS.RULE_TYPE.STATEFUL].indexOf(RULE_DATA[rule_d]["config"]["type"]) == -1)) {
					RULE_DATA[rule_d]["config"]["type"] = CONSTANTS.RULE_TYPE.STATELESS;
				}
				RULE_DATA[rule_d]["config"]["dir_name"] = rule_d;
				// Poll Counter will initialize to 0 if not already defined
				if (!RULE_DATA[rule_d]["config"]["poll_count"]) {
					RULE_DATA[rule_d]["config"]["poll_count"] = 0;
				}
				RULE_DATA[rule_d]["config"]["expr"] = expr_data;
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
			for (var k=0; k < RULE_DATA[rule]["config"]["alert_start"].length; k++) {
				if (ALERT_API.hasOwnProperty(RULE_DATA[rule]["config"]["alert_start"][k]["type"])) {
					// Check for Required Fields
					var req_fields_provided = true;
					if (ALERT_API[RULE_DATA[rule]["config"]["alert_start"][k]["type"]].required && typeof ALERT_API[RULE_DATA[rule]["config"]["alert_start"][k]["type"]].required == "object") {
						ALERT_API[RULE_DATA[rule]["config"]["alert_start"][k]["type"]].required.forEach(function(field){
							if (!RULE_DATA[rule]["config"]["alert_start"][k]["config"].hasOwnProperty(field) || !RULE_DATA[rule]["config"]["alert_start"][k]["config"][field]) {
								req_fields_provided = false;
								console.log("## Field '"+field+"' missing from '"+RULE_DATA[rule]["config"]["name"]+"' Config.")
							}
						});
					}

					if (!req_fields_provided) {
						// Remove that specific Alert from List
						console.log(">> Removing Alert Type '"+RULE_DATA[rule]["config"]["alert_start"][k]["type"]+"' due to incorrect configuration.")
						RULE_DATA[rule]["config"]["alert_start"].splice(k,1);
					}
				}
				else {
					console.log("## Alert Type '"+RULE_DATA[rule]["config"]["alert_start"][k]["type"]+"' not found!");
				}
			}
			for (var k=0; k < RULE_DATA[rule]["config"]["alert_end"].length; k++) {
				if (ALERT_API.hasOwnProperty(RULE_DATA[rule]["config"]["alert_end"][k]["type"])) {
					// Check for Required Fields
					var req_fields_provided = true;
					if (ALERT_API[RULE_DATA[rule]["config"]["alert_end"][k]["type"]].required && typeof ALERT_API[RULE_DATA[rule]["config"]["alert_end"][k]["type"]].required == "object") {
						ALERT_API[RULE_DATA[rule]["config"]["alert_end"][k]["type"]].required.forEach(function(field){
							if (!RULE_DATA[rule]["config"]["alert_end"][k]["config"].hasOwnProperty(field) || !RULE_DATA[rule]["config"]["alert_end"][k]["config"][field]) {
								req_fields_provided = false;
								console.log("## Field '"+field+"' missing from '"+RULE_DATA[rule]["config"]["name"]+"' Config.")
							}
						});
					}

					if (!req_fields_provided) {
						// Remove that specific Alert from List
						console.log(">> Removing Alert Type '"+RULE_DATA[rule]["config"]["alert_end"][k]["type"]+"' due to incorrect configuration.")
						RULE_DATA[rule]["config"]["alert_end"].splice(k,1);
					}
				}
				else {
					console.log("## Alert Type '"+RULE_DATA[rule]["config"]["alert_end"][k]["type"]+"' not found!");
				}
			}
			if (RULE_DATA[rule]["config"]["alert_start"].length > 0 || RULE_DATA[rule]["config"]["alert_end"].length > 0) {
				console.log("*** Adding Rule: " + RULE_DATA[rule]["config"]["name"]);
				// Make Alert Expression
				RULE_DATA[rule]["config"]["expr_parsed"] = makeSearchResponseExpr(RULE_DATA[rule]["config"]["expr"]);
				// Add Rule
				addRuleTimer(RULE_DATA[rule]);
				console.log(">> Sleeping for " + RULE_DATA[rule]["config"]["run_every"] + " seconds...");
			} else {
				// There are No Alert Type to Add
				console.log("## No Valid Alerts are set for '"+RULE_DATA[rule]["config"]["name"]+"'. Thus, ignoring this Rule!");
			}
		}
	}
}
else {
	console.log("No Rules found!");
}