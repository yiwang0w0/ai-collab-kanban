package statussummary

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/task/poolhistory"
	"github.com/stretchr/testify/require"
)

func poolSummaryFixture() poolhistory.Item {
	released := time.Date(2026, 10, 19, 1, 0, 0, 0, time.UTC)
	queued := released.Add(time.Second)
	return poolhistory.Item{EntryID: 42, RunID: "pool-summary-run", State: "queued",
		PlannedAgentProfileID: "pool-summary-profile", ReleasedAt: &released, QueuedAt: &queued}
}

func decodePoolSummaryWire(t *testing.T, item poolhistory.Item) TaskStatusSummary {
	t.Helper()
	// 使用原生投影的序列化形状，不把元数据夹具当成实际模型执行。
	encoded, err := json.Marshal(struct {
		Revision      uint64           `json:"revision"`
		UpdatedAt     time.Time        `json:"updated_at"`
		PoolExecution poolhistory.Item `json:"pool_execution"`
	}{Revision: 7, UpdatedAt: time.Date(2026, 10, 19, 2, 0, 0, 0, time.UTC), PoolExecution: item})
	require.NoError(t, err)
	var summary TaskStatusSummary
	require.NoError(t, json.Unmarshal(encoded, &summary))
	return summary
}

// @covers AC-TASKS-AGENT-POOL-002.1 AC-TASKS-AGENT-POOL-003.4
func TestTaskStatusSummaryPoolExecutionSurvivesNativeWireAndSemanticStorage(t *testing.T) {
	item := poolSummaryFixture()
	summary := decodePoolSummaryWire(t, item)
	encoded, err := summary.SemanticJSON()
	require.NoError(t, err)
	var decoded struct {
		PoolExecution *poolhistory.Item `json:"pool_execution"`
	}
	require.NoError(t, json.Unmarshal(encoded, &decoded))
	require.NotNil(t, decoded.PoolExecution, "完整摘要不能丢掉已核验的池执行事实")
	require.Equal(t, item, *decoded.PoolExecution)
	legacy, err := (TaskStatusSummary{}).SemanticJSON()
	require.NoError(t, err)
	require.NotContains(t, string(legacy), "pool_execution", "无绑定旧任务保持原生兼容形状")
}

func TestTaskStatusSummaryPoolExecutionChangesSemanticRevision(t *testing.T) {
	queued := poolSummaryFixture()
	claimed := queued
	claimedAt := queued.QueuedAt.Add(time.Second)
	claimed.State, claimed.ClaimID, claimed.ClaimedAt = "claimed", "pool-summary-claim", &claimedAt
	claimed.Current, claimed.ClaimedAgentProfileID = true, queued.PlannedAgentProfileID
	left, right := decodePoolSummaryWire(t, queued), decodePoolSummaryWire(t, claimed)
	require.False(t, left.SemanticEqual(right), "领取必须改变摘要语义，不能被当作没有变化而不发版本")
}

func TestTaskStatusSummaryPoolExecutionRejectsOversizedOrUnknownFacts(t *testing.T) {
	for _, mutate := range []struct {
		name string
		edit func(*poolhistory.Item)
	}{
		{"reason", func(item *poolhistory.Item) { item.Reason = strings.Repeat("x", 129) }},
		{"identity", func(item *poolhistory.Item) { item.ClaimID = strings.Repeat("x", 257) }},
		{"unknown_state", func(item *poolhistory.Item) { item.State = "invented-running" }},
	} {
		t.Run(mutate.name, func(t *testing.T) {
			item := poolSummaryFixture()
			mutate.edit(&item)
			summary := decodePoolSummaryWire(t, item)
			require.Error(t, summary.Validate())
		})
	}
}
