package service_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"testing"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-005.3
func TestPoolCancellationRace(t *testing.T) {
	for i := 0; i < 8; i++ {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			f := newPoolPublishFixture(t)
			command, run := poolWithdrawal(t, f)
			start := make(chan struct{})
			claimed := make(chan error, 1)
			withdrawn := make(chan error, 1)
			go func() {
				<-start
				claim, err := f.runs.ClaimNextEligibleRunWithClaim(context.Background())
				if err == nil && (claim == nil || claim.ID != run.ID) {
					err = errors.New("领取了错误的运行")
				}
				claimed <- err
			}()
			go func() {
				<-start
				_, err := f.svc.RecoverPoolRun(poolRecoveryHuman(), f.task.ID, command)
				withdrawn <- err
			}()
			close(start)
			claimErr, withdrawErr := <-claimed, <-withdrawn
			if claimErr == nil {
				require.ErrorIs(t, withdrawErr, runsmodels.ErrPoolRecoveryConflict)
			} else {
				require.ErrorIs(t, claimErr, sql.ErrNoRows)
				require.NoError(t, withdrawErr)
			}
			after, err := f.runs.GetRunByID(context.Background(), run.ID)
			require.NoError(t, err)
			var claims int
			require.NoError(t, f.runs.Reader().Get(&claims, `SELECT COUNT(*) FROM office_launch_ledger WHERE run_id=?`, run.ID))
			if claimErr == nil {
				require.Equal(t, runsmodels.RunStatusClaimed, after.Status)
				require.Equal(t, 1, claims)
			} else {
				require.Equal(t, "cancelled", string(after.Status))
				require.Zero(t, claims)
			}
		})
	}
}

func TestPoolRecoveryWithdrawalRollbackAndPostCommitRefresh(t *testing.T) {
	f := newPoolPublishFixture(t)
	command, run := poolWithdrawal(t, f)
	_, err := f.runs.Writer().Exec(`CREATE TRIGGER reject_pool_withdraw BEFORE UPDATE OF status ON runs WHEN NEW.status='cancelled' BEGIN SELECT RAISE(ABORT,'拒绝本测试的取消提交'); END`)
	require.NoError(t, err)
	calls := 0
	f.svc.SetPoolProjectionObserver(func(change runsmodels.PoolProjectionCommit) {
		calls++
		stored, err := f.runs.GetRunByID(context.Background(), run.ID)
		require.NoError(t, err)
		require.Equal(t, "cancelled", string(stored.Status), "刷新必须看得见已提交事实")
		require.Equal(t, "recovery", change.Kind)
	})
	event, err := f.svc.RecoverPoolRun(poolRecoveryHuman(), f.task.ID, command)
	require.Error(t, err)
	require.Nil(t, event)
	require.Zero(t, calls)
	rows, err := f.runs.ListRunEvents(context.Background(), run.ID, -1, 50)
	require.NoError(t, err)
	require.Empty(t, rows, "回滚不能遗留成功回执")
	_, err = f.runs.Writer().Exec(`DROP TRIGGER reject_pool_withdraw`)
	require.NoError(t, err)
	_, err = f.svc.RecoverPoolRun(poolRecoveryHuman(), f.task.ID, command)
	require.NoError(t, err)
	require.Equal(t, 1, calls)
	_, err = f.svc.RecoverPoolRun(poolRecoveryHuman(), f.task.ID, command)
	require.NoError(t, err)
	require.Equal(t, 1, calls, "重放不重复通知")
}
