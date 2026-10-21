package statussummary

import (
	"fmt"
	"time"

	"github.com/kandev/kandev/internal/task/poolhistory"
)

// PoolExecutionSummary 沿用原生证据投影形状，不包含提示、转录或日志。
type PoolExecutionSummary poolhistory.Item

// UnavailablePoolExecution 保留最后确认的事实，但不再把旧领取声明为当前活跃。
func UnavailablePoolExecution(previous *PoolExecutionSummary) *PoolExecutionSummary {
	value := clonePoolExecution(previous)
	if value == nil {
		value = &PoolExecutionSummary{}
	}
	value.State, value.Reason, value.Current = "unknown", "pool_read_unavailable", false
	return value
}

func clonePoolExecution(value *PoolExecutionSummary) *PoolExecutionSummary {
	if value == nil {
		return nil
	}
	result := *value
	result.ReleasedAt, result.QueuedAt = cloneTimePtr(value.ReleasedAt), cloneTimePtr(value.QueuedAt)
	result.ClaimedAt, result.StartedAt = cloneTimePtr(value.ClaimedAt), cloneTimePtr(value.StartedAt)
	result.TurnEndedAt = cloneTimePtr(value.TurnEndedAt)
	result.StoppedAt, result.EndedAt = cloneTimePtr(value.StoppedAt), cloneTimePtr(value.EndedAt)
	return &result
}

func validatePoolExecution(value *PoolExecutionSummary) error {
	if value == nil {
		return nil
	}
	if value.EntryID < 0 || !knownPoolSummaryState(value.State) {
		return fmt.Errorf("invalid pool execution summary")
	}
	if err := validateUTF8Bytes("pool reason", value.Reason, 128); err != nil {
		return err
	}
	for _, identity := range []string{value.RunID, value.ClaimID, value.PlannedAgentProfileID, value.ClaimedAgentProfileID,
		value.SessionID, value.ExecutionID, value.ExecutionProfileID, value.TurnID, value.OperationID} {
		if err := validateUTF8Bytes("pool identity", identity, 256); err != nil {
			return err
		}
	}
	for _, label := range []string{value.OperationSource, value.TurnOutcome} {
		if err := validateUTF8Bytes("pool operation label", label, 32); err != nil {
			return err
		}
	}
	for _, timestamp := range []*time.Time{value.ReleasedAt, value.QueuedAt, value.ClaimedAt, value.StartedAt,
		value.TurnEndedAt, value.StoppedAt, value.EndedAt} {
		if timestamp != nil && timestamp.IsZero() {
			return fmt.Errorf("invalid pool execution timestamp")
		}
	}
	return nil
}

func knownPoolSummaryState(state string) bool {
	switch state {
	case "released", "queued", "claimed", "started", "turn_ended", "turn_failed", "stopped", "ended", "unknown":
		return true
	default:
		return false
	}
}
