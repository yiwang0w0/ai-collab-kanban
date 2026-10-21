package handlers

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestPoolProjectionHTTPDistinguishesUnconfiguredApprovalAndUnavailableProfile(t *testing.T) {
	f := newPoolMoveWireFixture(t)
	ordinary := readPoolProjectionCard(t, f)
	require.Equal(t, "not_applicable", ordinary.Eligibility.State)
	require.Equal(t, "pool_stage_not_configured", ordinary.Eligibility.Reason)
	// 用原生序列化的阶段配置模拟既有卡片所在阶段改为池阶段，不伪造入池批准。
	encoded, err := json.Marshal(f.step.Events)
	require.NoError(t, err)
	_, err = f.database.Exec(`UPDATE workflow_steps SET agent_profile_id=?,events=? WHERE id=?`,
		f.step.AgentProfileID, string(encoded), f.task.WorkflowStepID)
	require.NoError(t, err)
	before := poolHistorySourceCounts(t, f)
	unapproved := readPoolProjectionCard(t, f)
	require.Nil(t, unapproved.PoolExecution)
	require.Equal(t, "approval_required", unapproved.Eligibility.State)
	require.Equal(t, "cli_quota_confirmation_required", unapproved.Eligibility.Reason)
	require.Equal(t, before, poolHistorySourceCounts(t, f))
	_, err = f.database.Exec(`UPDATE agent_profiles SET enabled=0 WHERE id=?`, f.step.AgentProfileID)
	require.NoError(t, err)
	disabled := readPoolProjectionCard(t, f)
	require.Equal(t, "blocked", disabled.Eligibility.State)
	require.Equal(t, "pool_execution_capability_unavailable", disabled.Eligibility.Reason)
	require.Nil(t, disabled.PoolExecution)
}

func TestPoolProjectionHTTPKeepsNativeEmptyStepEventsUnconfigured(t *testing.T) {
	f := newPoolMoveWireFixture(t)
	_, err := f.database.Exec(`UPDATE workflow_steps SET events='' WHERE id=?`, f.task.WorkflowStepID)
	require.NoError(t, err)
	card := readPoolProjectionCard(t, f)
	require.Equal(t, "not_applicable", card.Eligibility.State, "原生 reader 接受空事件配置，不能把普通阶段报成损坏池配置")
	require.Equal(t, "pool_stage_not_configured", card.Eligibility.Reason)
}
