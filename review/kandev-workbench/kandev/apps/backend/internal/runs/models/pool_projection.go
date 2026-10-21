package models

// PoolProjectionHistoryCleaned 与 run_events 的序号域分离，不伪造执行事件序号。
const PoolProjectionHistoryCleaned = "history_cleaned"

// 入队提示没有持久事件序号，首个恢复事件必须使用独立的去重域。
const PoolProjectionRecovery = "recovery"

// PoolProjectionCommit 只合并提交后的读刷新；不是领取、启动或恢复的授权票据。
type PoolProjectionCommit struct {
	TaskID   string
	RunID    string
	ClaimID  string
	Sequence int
	Kind     string
}
