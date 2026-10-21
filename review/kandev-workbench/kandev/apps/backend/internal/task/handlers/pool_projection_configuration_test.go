package handlers

import (
	"strconv"
	"testing"
	"time"

	workflowmodels "github.com/kandev/kandev/internal/workflow/models"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-001.2 AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-003.2
func TestPoolProjectionHTTPConfigurationChangesDoNotTurnOldApprovalIntoNewWork(t *testing.T) {
	for _, change := range []string{"移除池配置", "切换阶段执行者"} {
		t.Run(change, func(t *testing.T) {
			f := queuedPoolHistoryFixture(t)
			claim, err := f.runs.ClaimNextEligibleRunWithClaim(f.ctx)
			require.NoError(t, err)
			require.NotNil(t, claim)
			baseline := readPoolProjectionCard(t, f)
			require.NotNil(t, baseline.PoolExecution)
			require.Equal(t, "claimed", baseline.PoolExecution.State)
			require.Equal(t, claim.ClaimID, baseline.PoolExecution.ClaimID)
			require.Equal(t, claim.AgentProfileID, baseline.PoolExecution.ClaimedAgentProfileID)
			changedAt := baseline.PoolExecution.ReleasedAt.Add(time.Second)
			if change == "移除池配置" {
				_, err := f.database.Exec(`UPDATE workflow_steps SET events='{}',updated_at=? WHERE id=?`, changedAt, f.step.ID)
				require.NoError(t, err)
			} else {
				_, err := f.database.Exec(`INSERT INTO agent_profiles(id,agent_id,name,agent_display_name,enabled,created_at,updated_at)
					SELECT 'pool-current-profile',agent_id,'当前配置','CLI',1,created_at,updated_at FROM agent_profiles WHERE id=?`, f.step.AgentProfileID)
				require.NoError(t, err)
				_, err = f.database.Exec(`UPDATE workflow_steps SET agent_profile_id='pool-current-profile',updated_at=? WHERE id=?`, changedAt, f.step.ID)
				require.NoError(t, err)
			}
			var entryID int64
			require.NoError(t, f.database.Get(&entryID, `SELECT MAX(id) FROM task_step_transitions WHERE task_id=?`, f.task.ID))
			before := poolHistorySourceCounts(t, f)
			_, err = f.service.PublishPoolRelease(f.ctx, f.task.ID, f.step.ID, strconv.FormatInt(entryID, 10))
			require.ErrorIs(t, err, workflowmodels.ErrInvalidPoolStep)
			after := readPoolProjectionCard(t, f)
			require.Equal(t, before, poolHistorySourceCounts(t, f))
			require.Equal(t, baseline.PoolExecution, after.PoolExecution)
			require.Equal(t, "requires_revalidation", after.Eligibility.State)
			require.Equal(t, "pool_stage_configuration_changed", after.Eligibility.Reason)
		})
	}
}
