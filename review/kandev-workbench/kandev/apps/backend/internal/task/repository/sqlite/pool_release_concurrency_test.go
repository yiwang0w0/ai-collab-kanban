package sqlite_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/task/repository/repoerrors"
	"github.com/kandev/kandev/internal/testutil"
)

// @covers AC-TASKS-AGENT-POOL-001.3
func TestPoolDispatchConcurrentConfirmationsCommitOneEntry(t *testing.T) {
	repo, original, target := poolAdmissionFixture(t, true)
	ctx := confirmedPoolMoveContext(original, target)
	start := make(chan struct{})
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			candidate := *original
			candidate.WorkflowStepID = target
			<-start
			errs <- repo.UpdateTask(ctx, &candidate)
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	committed, conflicted := 0, 0
	for err := range errs {
		if err == nil {
			committed++
		} else if errors.Is(err, repoerrors.ErrTaskVersionConflict) {
			conflicted++
		} else {
			t.Fatal(err)
		}
	}
	if committed != 1 || conflicted != 1 {
		t.Fatalf("并发确认应只有一个提交: committed=%d conflicted=%d", committed, conflicted)
	}
	var count int
	if err := repo.db.Get(&count, `SELECT COUNT(*) FROM task_step_transitions WHERE task_id = ? AND trigger = 'pool_release_v1'`, original.ID); err != nil || count != 1 {
		t.Fatalf("同次确认产生了多份阶段身份: count=%d err=%v", count, err)
	}
}

func TestPoolDispatchPostgresFailsClosedWithoutChangingOrdinaryTasks(t *testing.T) {
	database := testutil.OpenIsolatedPostgres(t, testutil.PostgresDSNFromEnv(t))
	repo, err := newPoolAdmissionRepositoryWithDB(database)
	if err != nil {
		t.Fatal(err)
	}
	original := seedPoolAdmissionRows(t, repo, "postgres-pool-task")
	original.Title = "ordinary-update"
	if err := repo.UpdateTask(context.Background(), original); err != nil {
		t.Fatalf("普通更新不能被池限制改变: %v", err)
	}
	original, err = repo.GetTask(context.Background(), original.ID)
	if err != nil {
		t.Fatal(err)
	}
	target := "workflow-change-target-step"
	version, err := time.Parse(time.RFC3339Nano, poolStepFixtureVersion)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(database.Rebind(`UPDATE workflow_steps SET workflow_id = ?, agent_profile_id = 'fixed-profile',
		events = ?, updated_at = ? WHERE id = ?`), original.WorkflowID,
		`{"on_enter":[{"type":"queue_run","config":{"pool_version":1}}]}`, version, target); err != nil {
		t.Fatal(err)
	}
	candidate := *original
	candidate.WorkflowStepID = target
	if err := repo.UpdateTask(confirmedPoolMoveContext(original, target), &candidate); !errors.Is(err, repoerrors.ErrPoolStorageUnsupported) {
		t.Fatalf("未支持的池存储不能隐式启用: %v", err)
	}
	stored, err := repo.GetTask(context.Background(), original.ID)
	if err != nil || stored.WorkflowStepID != original.WorkflowStepID {
		t.Fatalf("拒绝后没有保留普通任务: %+v %v", stored, err)
	}
}
