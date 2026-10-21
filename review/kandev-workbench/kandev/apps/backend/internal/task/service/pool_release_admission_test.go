package service

import (
	"context"
	"errors"
	"testing"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
)

type poolReleaseAdmissionSetter interface {
	SetPoolReleaseAdmission(PoolReleaseAdmission)
}

type poolReleaseAdmissionFunc func(context.Context, string, func(context.Context) error) error

func (f poolReleaseAdmissionFunc) WithPoolReleaseAdmission(ctx context.Context, taskID string, fn func(context.Context) error) error {
	return f(ctx, taskID, fn)
}

// @covers AC-TASKS-AGENT-POOL-001.1 AC-TASKS-AGENT-POOL-001.3
func TestPoolDispatchConfirmedMoveRequiresSharedStartAdmission(t *testing.T) {
	denied := errors.New("启动准备尚未退出")
	for _, tc := range []struct {
		name string
		gate PoolReleaseAdmission
		want error
	}{
		{name: "unconfigured", want: runsmodels.ErrPoolAdmissionUnavailable},
		{name: "preparing", want: denied, gate: poolReleaseAdmissionFunc(func(context.Context, string, func(context.Context) error) error { return denied })},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newPoolMoveFixture(t)
			setter, ok := any(f.svc).(poolReleaseAdmissionSetter)
			if !ok {
				t.Fatal("确认移动没有连接原生任务启动准入")
			}
			setter.SetPoolReleaseAdmission(tc.gate)
			before, err := f.repo.GetTask(context.Background(), f.task.ID)
			if err != nil {
				t.Fatal(err)
			}
			var entriesBefore, entriesAfter int
			if err := f.database.Get(&entriesBefore, `SELECT COUNT(*) FROM task_step_transitions WHERE task_id = ?`, f.task.ID); err != nil {
				t.Fatal(err)
			}
			result, err := f.svc.MoveTaskWithOptions(f.ctx, f.task.ID, f.task.WorkflowID, f.step.ID, 0, f.opts)
			if !errors.Is(err, tc.want) || result != nil {
				t.Fatalf("批准必须在共享准入成功后才提交: result=%+v err=%v", result, err)
			}
			after, err := f.repo.GetTask(context.Background(), f.task.ID)
			if err != nil || after.WorkflowStepID != before.WorkflowStepID || !after.UpdatedAt.Equal(before.UpdatedAt) {
				t.Fatalf("拒绝不能先移动原卡或改变版本: after=%+v err=%v", after, err)
			}
			if err := f.database.Get(&entriesAfter, `SELECT COUNT(*) FROM task_step_transitions WHERE task_id = ?`, f.task.ID); err != nil || entriesAfter != entriesBefore {
				t.Fatalf("拒绝不能留下新的批准账本: before=%d after=%d err=%v", entriesBefore, entriesAfter, err)
			}
		})
	}
}
