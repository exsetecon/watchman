(function(){
	// A value that uniquely identifies an Alert
	${ALERT_ID} = ${es.aggregations['2'].buckets[i].key};
	// If Response Time gets more than 5 seconds
	if (${es.aggregations['2'].buckets[i]['1'].value} > 5) {
		return true;
	} else {
		return false;
	}
})()