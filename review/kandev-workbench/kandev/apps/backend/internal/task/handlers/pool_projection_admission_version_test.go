package handlers

import (
	"testing"
	"time"

	workflowmodels "github.com/kandev/kandev/internal/workflow/models"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-001.2 AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-003.2
func TestPoolProjectionHTTPRequiresRevalidationWhenApprovedStepVersionChanges(t *testing.T) {
	for _, claimed := range []bool{false, true} {
		name := "已入队"
		if claimed {
			name = "已领取"
		}
		t.Run(name, func(t *testing.T) {
			f := queuedPoolHistoryFixture(t)
			if claimed {
				claim, err := f.runs.ClaimNextEligibleRunWithClaim(f.ctx)
				require.NoError(t, err)
				require.NotNil(t, claim)
			}
			baseline := readPoolProjectionCard(t, f)
			require.NotNil(t, baseline.PoolExecution)
			require.NotNil(t, baseline.PoolExecution.ReleasedAt)
			require.Equal(t, "occupied", baseline.Eligibility.State)
			var entryID int64
			require.NoError(t, f.database.Get(&entryID,
				`SELECT MAX(id) FROM task_step_transitions WHERE task_id=?`, f.task.ID))
			_, err := f.tasks.LoadPoolRelease(f.ctx, f.task.ID, entryID)
			require.NoError(t, err, "未变化的真实批准必须仍可读取，不能用始终拒绝的夹具证明门禁")
			// 只构造原生配置版本变化，不改变已提交批准或运行事实。
			changedAt := baseline.PoolExecution.ReleasedAt.Add(time.Second)
			_, err = f.database.Exec(`UPDATE workflow_steps SET updated_at=? WHERE id=?`, changedAt, f.step.ID)
			require.NoError(t, err)
			_, err = f.tasks.LoadPoolRelease(f.ctx, f.task.ID, entryID)
			require.ErrorIs(t, err, workflowmodels.ErrInvalidPoolStep)
			before := poolHistorySourceCounts(t, f)
			after := readPoolProjectionCard(t, f)
			require.Equal(t, before, poolHistorySourceCounts(t, f))
			require.Equal(t, baseline.PoolExecution, after.PoolExecution, "显示准入变化不能重写已确认的领取或时间")
			require.Equal(t, "requires_revalidation", after.Eligibility.State)
			require.Equal(t, "pool_stage_configuration_changed", after.Eligibility.Reason)
		})
	}
}
