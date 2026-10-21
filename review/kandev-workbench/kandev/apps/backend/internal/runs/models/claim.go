package models

// ClaimedRun 将本次领取的不可变账本身份与运行快照一起返回，不新增持久化字段。
type ClaimedRun struct {
	*Run
	ClaimID string
}
