(function(){
	var buckets = ${es.aggregations['2'].buckets};

	// For Each Bucket that we have, run a Loop
	// Example: a Bucket of all Apache Servers with their Response Time
	buckets.forEach(function(server){
		// A value that uniquely identifies an Alert
		${ALERT_ID} = server.key;
		${tmp.server_ip} = server.key;
		${tmp.response_time} = server['1'].value.toFixed(2);
		// If Response Time gets more than 5 seconds
		if (server['1'].value > 5) {
			alertUp();
		} else {
			alertDown();
		}
	});
})()