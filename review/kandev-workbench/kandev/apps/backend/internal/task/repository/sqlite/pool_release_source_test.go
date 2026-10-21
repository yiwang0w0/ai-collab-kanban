package sqlite_test

import (
	"context"
	"testing"
	"time"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
)

type poolReleaseSourceReader interface {
	LoadPoolRelease(context.Context, string, int64) (runsmodels.PoolReleaseSnapshot, error)
}

// @covers AC-TASKS-AGENT-POOL-001.3 AC-TASKS-AGENT-POOL-002.1 AC-TASKS-AGENT-POOL-005.4
func TestPoolDispatchSourceUsesCommittedReleaseOnly(t *testing.T) {
	repo, original, target := poolAdmissionFixture(t, true)
	reader, ok := any(repo).(poolReleaseSourceReader)
	if !ok {
		t.Fatal("缺少从已提交阶段账本读取池派发身份的入口")
	}
	candidate := *original
	candidate.WorkflowStepID = target
	if err := repo.UpdateTask(confirmedPoolMoveContext(original, target), &candidate); err != nil {
		t.Fatal(err)
	}
	var entryID int64
	if err := repo.db.Get(&entryID, `SELECT MAX(id) FROM task_step_transitions WHERE task_id = ?`, original.ID); err != nil {
		t.Fatal(err)
	}
	snapshot, err := reader.LoadPoolRelease(context.Background(), original.ID, entryID)
	if err != nil || snapshot.TaskID != original.ID || snapshot.WorkspaceID != original.WorkspaceID ||
		snapshot.WorkflowID != original.WorkflowID || snapshot.WorkflowStepID != target ||
		snapshot.EntryID != entryID || snapshot.ActorID != "pool-human" || snapshot.AgentProfileID != "fixed-profile" ||
		!snapshot.ReleasedAt.Equal(candidate.UpdatedAt) {
		t.Fatalf("派发身份不是原生账本的事实: %+v %v", snapshot, err)
	}
	if _, err := reader.LoadPoolRelease(context.Background(), "other-task", entryID); err == nil {
		t.Fatal("账本不得跨任务套用")
	}
	if _, err := reader.LoadPoolRelease(context.Background(), original.ID, entryID-1); err == nil {
		t.Fatal("旧阶段不能成为当前派发")
	}
	if _, err := repo.db.Exec(`UPDATE task_step_transitions SET trigger = 'manual_move' WHERE id = ?`, entryID); err != nil {
		t.Fatal(err)
	}
	if _, err := reader.LoadPoolRelease(context.Background(), original.ID, entryID); err == nil {
		t.Fatal("普通真人移动不等于明确入池确认")
	}
}

func TestPoolDispatchSourceDoesNotGuessChangedConfiguration(t *testing.T) {
	repo, original, target := poolAdmissionFixture(t, true)
	reader, ok := any(repo).(poolReleaseSourceReader)
	if !ok {
		t.Fatal("缺少可信池发布读取入口")
	}
	candidate := *original
	candidate.WorkflowStepID = target
	if err := repo.UpdateTask(confirmedPoolMoveContext(original, target), &candidate); err != nil {
		t.Fatal(err)
	}
	var entryID int64
	if err := repo.db.Get(&entryID, `SELECT MAX(id) FROM task_step_transitions WHERE task_id = ?`, original.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.db.Exec(`UPDATE workflow_steps SET updated_at = ?, agent_profile_id = 'another-profile' WHERE id = ?`, candidate.UpdatedAt.Add(time.Minute), target); err != nil {
		t.Fatal(err)
	}
	if _, err := reader.LoadPoolRelease(context.Background(), original.ID, entryID); err == nil {
		t.Fatal("确认后的配置变化不能静默换执行者")
	}
	stored, err := repo.GetTask(context.Background(), original.ID)
	if err != nil || !stored.UpdatedAt.Equal(candidate.UpdatedAt) {
		t.Fatalf("只读重建不得改任务: %+v %v", stored, err)
	}
}
