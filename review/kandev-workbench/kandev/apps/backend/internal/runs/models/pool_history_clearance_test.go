package models

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestPoolHistoryClearanceRejectsStructurallyIncompleteProducerBinding(t *testing.T) {
	valid := PoolReleaseSnapshot{TaskID: "task", WorkspaceID: "workspace", WorkflowID: "workflow",
		WorkflowStepID: "step", EntryID: 1, AgentProfileID: "profile", ActorID: "human", ReleasedAt: time.Now().UTC()}
	for _, mutate := range []func(*PoolReleaseSnapshot){
		func(r *PoolReleaseSnapshot) { r.TaskID = "" },
		func(r *PoolReleaseSnapshot) { r.WorkspaceID = "" },
		func(r *PoolReleaseSnapshot) { r.WorkflowID = "" },
		func(r *PoolReleaseSnapshot) { r.WorkflowStepID = "" },
		func(r *PoolReleaseSnapshot) { r.ActorID = "" },
		func(r *PoolReleaseSnapshot) { r.ActorID = strings.Repeat("x", 257) },
		func(r *PoolReleaseSnapshot) { r.EntryID = 0 },
		func(r *PoolReleaseSnapshot) { r.ReleasedAt = time.Time{} },
	} {
		release := valid
		mutate(&release)
		run := poolHistoryProducerRun(t, release)
		_, accepted := PoolReleaseForHistory(run)
		require.False(t, accepted, "生产形状内部自洽也不能把缺失批准身份当有效凭证")
	}
	_, accepted := PoolReleaseForHistory(poolHistoryProducerRun(t, valid))
	require.True(t, accepted)
}

func poolHistoryProducerRun(t *testing.T, release PoolReleaseSnapshot) *Run {
	t.Helper()
	payload, err := json.Marshal(poolRunEnvelope{TaskID: release.TaskID, WorkflowStepID: release.WorkflowStepID,
		AgentProfileID: release.AgentProfileID, PoolRelease: release})
	require.NoError(t, err)
	key, err := release.DispatchKey()
	require.NoError(t, err)
	return &Run{ID: "run", WorkspaceID: release.WorkspaceID, AgentProfileID: release.AgentProfileID,
		Reason: PoolDispatchReason, Status: RunStatusFinished, IdempotencyKey: &key, Payload: string(payload),
		ActorKind: ActorKindUser, ActorID: release.ActorID, CoalescedCount: 1, RequestedAt: time.Now().UTC()}
}
