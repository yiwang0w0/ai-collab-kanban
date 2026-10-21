package models

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

const PoolDispatchReason = "pool_dispatch"

// DispatchKey 的摘要只依赖不可变阶段身份，JSON 数组保留字段边界。
func (r PoolReleaseSnapshot) DispatchKey() (string, error) {
	identity, err := json.Marshal([]any{r.WorkspaceID, r.TaskID, r.EntryID})
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(identity)
	return PoolDispatchKeyPrefix + hex.EncodeToString(digest[:]), nil
}

type poolRunEnvelope struct {
	TaskID         string              `json:"task_id"`
	WorkflowStepID string              `json:"workflow_step_id"`
	AgentProfileID string              `json:"agent_profile_id"`
	PoolRelease    PoolReleaseSnapshot `json:"pool_release"`
}

// MatchesRun 验证队列结果仍属于同一批准，不以非空行或同键字符串代替绑定。
func (r PoolReleaseSnapshot) MatchesRun(row *Run) bool {
	if row == nil || row.ID == "" || row.IdempotencyKey == nil || !knownPoolRunStatus(row.Status) {
		return false
	}
	key, err := r.DispatchKey()
	if err != nil || *row.IdempotencyKey != key || !r.matchesRunColumns(row) {
		return false
	}
	var envelope poolRunEnvelope
	if json.Unmarshal([]byte(row.Payload), &envelope) != nil {
		return false
	}
	return envelope.TaskID == r.TaskID && envelope.WorkflowStepID == r.WorkflowStepID &&
		envelope.AgentProfileID == r.AgentProfileID && r.sameBinding(envelope.PoolRelease)
}

func (r PoolReleaseSnapshot) matchesRunColumns(row *Run) bool {
	return row.AgentProfileID == r.AgentProfileID && row.WorkspaceID == r.WorkspaceID &&
		row.Reason == PoolDispatchReason && row.ActorKind == ActorKindUser && row.ActorID == r.ActorID &&
		row.CoalescedCount == 1 && row.WakeWaveKey == "" && row.WakeWaveString == ""
}

func (r PoolReleaseSnapshot) sameBinding(other PoolReleaseSnapshot) bool {
	return r.TaskID == other.TaskID && r.WorkspaceID == other.WorkspaceID && r.WorkflowID == other.WorkflowID &&
		r.WorkflowStepID == other.WorkflowStepID && r.EntryID == other.EntryID && r.AgentProfileID == other.AgentProfileID &&
		r.ActorID == other.ActorID && r.ReleasedAt.Equal(other.ReleasedAt)
}

func knownPoolRunStatus(status RunStatus) bool {
	switch status {
	case "queued", "claimed", "finished", "failed", "cancelled":
		return true
	default:
		return false
	}
}
