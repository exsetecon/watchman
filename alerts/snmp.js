var snmp = require('net-snmp');

module.exports = function(logger){

	var sender = {
		name: "snmp",
		required: ["host"]
	};

	sender.init = function(){
		console.log("SNMP Plugin Loaded successfully!");
	};

	sender.sendAlert = function(config, alert_text, callback){
		var host = config.host ? config.host : "localhost";
		var community = config.community ? config.community : "public";
		var session = snmp.createSession(host, community);
		var enterpriseOid = config.enterprise_oid ? config.enterprise_oid : "1.3.6.1.4.1";
		var varbinds = config.varbinds ? config.varbinds : [];

		// Replace Data Types
		for (var j=0; j < varbinds.length; j++) {
			if (varbinds[j].type == "OctetString") {
				varbinds[j].type = snmp.ObjectType.OctetString;
			}
			if (varbinds[j].type == "Boolean") {
				varbinds[j].type = snmp.ObjectType.Boolean;
			}
			if (varbinds[j].type == "Integer") {
				varbinds[j].type = snmp.ObjectType.Integer;
			}
		}

		var agentAddress = "127.0.0.1";

		session.trap(enterpriseOid, varbinds, agentAddress, function (error) {
			if (error) {
				callback(error);
			} else {
				callback(null);
			}
		});
/*
		session.trap(enterpriseOid, varbinds, function (error) {
			if (error) {
				callback(error);
			} else {
				callback(null);
			}
		});
*/
	};
	return sender;
};