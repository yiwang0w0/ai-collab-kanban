package models

const (
	PoolExecutionFinished       = "pool.execution-finished.v1"
	PoolOutcomeExecutionStopped = "pool_execution_stopped"
)

// PoolExecutionFinishReceipt 只结束本次队列领取；不代表主卡验收或产物合格。
type PoolExecutionFinishReceipt struct {
	PoolExecutionIdentity
	StoppedSeq int `json:"stopped_seq"`
}
