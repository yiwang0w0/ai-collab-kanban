package models

import "strings"

const PoolStopStandaloneControl = "standalone_control_v1"

// PoolExecutionStopReceipt 记录整次原生执行的停止，不补造提供商 operation 或 checkout 释放。
type PoolExecutionStopReceipt struct {
	PoolExecutionIdentity
	Source                    string `json:"source"`
	RuntimeInstanceID         string `json:"runtime_instance_id"`
	ExecutionActivityReleased bool   `json:"execution_activity_released"`
}

func (a PoolExecutionActivity) StoppedReceipt(allocation PoolExecutionAllocation, source, runtimeInstanceID string, released bool) (PoolExecutionStopReceipt, bool) {
	if a.StartedSource != "" || a.OperationID != "" || !a.matchesAllocation(allocation) ||
		source != PoolStopStandaloneControl || runtimeInstanceID == "" || len(runtimeInstanceID) > 256 || strings.TrimSpace(runtimeInstanceID) != runtimeInstanceID {
		return PoolExecutionStopReceipt{}, false
	}
	return PoolExecutionStopReceipt{PoolExecutionIdentity: allocation.PoolExecutionIdentity, Source: source,
		RuntimeInstanceID: runtimeInstanceID, ExecutionActivityReleased: released}, true
}
