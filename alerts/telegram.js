var request = require('request');

module.exports = function(logger){

	var telegram = {
		name: "telegram",
		required: ["bot_token", "room_id"]
	};

	telegram.init = function(){
		console.log("Telegram Loaded successfully!");
	};
	
	telegram.sendAlert = function(config, alert_text, callback){
//		console.log("Config: ", JSON.stringify(config));
//		console.log("Sending Telegram: ", alert_text);
//		callback(null);
//		return;
		var api_url = "https://api.telegram.org/bot" + config.bot_token + "/sendMessage";
		var request_data = {
			chat_id: config.room_id,
			text: alert_text,
			parse_mode: "markdown",
			disable_web_page_preview: true
		};
		var options = {
			url: api_url,
			headers: {
				"Content-Type" : "application/json"
			},
			body: JSON.stringify(request_data)
		};
		request.post(options, function(error, response, body){
			if (error) {
				callback(error);
			}
			else {
				callback(null);
			}
		});
	};

	return telegram;
};