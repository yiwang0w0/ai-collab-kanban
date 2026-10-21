package sqlite

// 选中领取的完整凭证，加首轮准入、最后池事件及每次准入前的排队原因。
// 每个因果边只取一个原生事件，不能按时间戳猜轮次或加载全部历史日志。
const poolCausalEventScopeSQL = `(
	CASE WHEN json_valid(e.payload) THEN
		(json_type(e.payload,'$.claim_id') IS NOT 'text' OR json_extract(e.payload,'$.claim_id')='' OR json_extract(e.payload,'$.claim_id') IN (?))
		ELSE 1 END
	OR e.seq=(SELECT first.seq FROM run_events first WHERE first.run_id=e.run_id AND first.event_type='pool.launch-admitted.v1' ORDER BY first.seq LIMIT 1)
	OR e.seq=(SELECT last.seq FROM run_events last WHERE last.run_id=e.run_id AND last.event_type LIKE 'pool.%' ORDER BY last.seq DESC LIMIT 1)
	OR e.seq IN (SELECT (SELECT prior.seq FROM run_events prior WHERE prior.run_id=e.run_id
		AND prior.event_type LIKE 'pool.%' AND prior.seq<intent.seq ORDER BY prior.seq DESC LIMIT 1)
		FROM run_events intent WHERE intent.run_id=e.run_id AND intent.event_type='pool.launch-admitted.v1'
		AND CASE WHEN json_valid(intent.payload) THEN json_extract(intent.payload,'$.claim_id') IN (?) ELSE 0 END)
)`
