package models

import (
	"encoding/json"
	"errors"
	"time"
	"unicode/utf8"
)

var (
	ErrPoolHistoryCleaned = errors.New("pool_history_cleaned")
	ErrPoolHistoryLegacy  = errors.New("pool_legacy_dispatch_unverified")
)

// PoolHistoryClearance 只保留已清理派发的身份，不是活动 Run 或执行回执。
type PoolHistoryClearance struct {
	DispatchKey string    `db:"dispatch_key"`
	RunID       string    `db:"run_id"`
	Version     int       `db:"format_version"`
	WorkspaceID string    `db:"workspace_id"`
	TaskID      string    `db:"task_id"`
	EntryID     int64     `db:"entry_id"`
	ReleaseJSON string    `db:"release_json"`
	RequestedAt time.Time `db:"requested_at"`
	ClearedAt   time.Time `db:"cleared_at"`
}

func (c PoolHistoryClearance) Release() (PoolReleaseSnapshot, bool) {
	var release PoolReleaseSnapshot
	if c.Version != 1 || c.RunID == "" || len(c.RunID) > 256 || len(c.ReleaseJSON) > 16384 ||
		c.RequestedAt.IsZero() || c.ClearedAt.IsZero() || json.Unmarshal([]byte(c.ReleaseJSON), &release) != nil {
		return release, false
	}
	key, err := release.DispatchKey()
	valid := validPoolHistoryRelease(release) && err == nil && key == c.DispatchKey && release.TaskID == c.TaskID &&
		release.WorkspaceID == c.WorkspaceID && release.EntryID == c.EntryID &&
		release.AgentProfileID != "" && len(release.AgentProfileID) <= 256
	return release, valid
}

// PoolReleaseForHistory 只接受生产者的原始序列化形状和规范绑定。
func PoolReleaseForHistory(run *Run) (PoolReleaseSnapshot, bool) {
	var envelope poolRunEnvelope
	if run == nil || len(run.Payload) > 16384 || run.RequestedAt.IsZero() ||
		len(run.ID) > 256 || json.Unmarshal([]byte(run.Payload), &envelope) != nil {
		return PoolReleaseSnapshot{}, false
	}
	return envelope.PoolRelease, validPoolHistoryRelease(envelope.PoolRelease) && envelope.PoolRelease.MatchesRun(run)
}

func validPoolHistoryRelease(release PoolReleaseSnapshot) bool {
	if release.EntryID <= 0 || release.ReleasedAt.IsZero() {
		return false
	}
	for _, id := range []string{release.TaskID, release.WorkspaceID, release.WorkflowID,
		release.WorkflowStepID, release.AgentProfileID, release.ActorID} {
		if id == "" || len(id) > 256 || !utf8.ValidString(id) {
			return false
		}
	}
	return true
}
