package sqlite_test

import (
	"errors"
	"testing"
	"testing/synctest"

	"github.com/kandev/kandev/internal/task/repository/repoerrors"
)

// @covers AC-TASKS-AGENT-POOL-001.3 AC-TASKS-AGENT-POOL-005.4
func TestPoolDispatchConfirmationCannotReplayWhenClockDoesNotAdvance(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		repo, original, target := poolAdmissionFixture(t, true)
		ctx := confirmedPoolMoveContext(original, target)
		first := *original
		first.WorkflowStepID = target
		if err := repo.UpdateTask(ctx, &first); err != nil {
			t.Fatal(err)
		}
		if !first.UpdatedAt.Equal(original.UpdatedAt) {
			t.Fatal("固定时钟必须覆盖提交前后的版本相同条件")
		}
		replay := *original
		replay.WorkflowStepID = target
		if err := repo.UpdateTask(ctx, &replay); !errors.Is(err, repoerrors.ErrTaskVersionConflict) {
			t.Fatalf("阶段已提交后旧确认必须冲突，即使墙上时钟未前进：%v", err)
		}
		var count int
		if err := repo.db.Get(&count, `SELECT COUNT(*) FROM task_step_transitions WHERE task_id=? AND trigger='pool_release_v1'`, original.ID); err != nil || count != 1 {
			t.Fatalf("批准账本应保持唯一：count=%d err=%v", count, err)
		}
	})
}
