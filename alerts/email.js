var nodemailer = require('nodemailer');

module.exports = function(logger){

	var email = {
		name: "email",
		required: ["host", "from_email", "to_email", "subject"]
	};
	
	email.init = function(){
		console.log("Email Plugin Loaded successfully!");
	};
	
	email.sendAlert = function(config, alert_text, callback){
//		console.log("Config: ", JSON.stringify(config));
//		console.log("Sending Email: ", alert_text);
//		callback(null);
//		return;
		if (config.username) {
			config.username = config.username.replace("@", "%40");
		}
		var transporter = nodemailer.createTransport("smtp://"+(config.username ? config.username+":"+config.password+"@" : "")+config.host);

		var mailOptions = {
			from: config.from_email,
			to: config.to_email,
			subject: config.subject,
			text: alert_text,
		};
		
		if (config.type && config.type.toUpperCase() == "HTML") {
			mailOptions.html = alert_text;
		}
		
		transporter.sendMail(mailOptions, function(error, info){
			if(error){
				callback(error);
			} else {
				callback(null);
			}
		});
	};

	return email;
};