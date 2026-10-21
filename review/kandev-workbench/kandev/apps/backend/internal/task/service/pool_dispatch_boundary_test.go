package service

import (
	"context"
	"fmt"
	"strconv"
	"testing"

	"github.com/kandev/kandev/internal/auth/authn"
)

// @covers AC-TASKS-AGENT-POOL-001.3 AC-TASKS-AGENT-POOL-005.4
func TestPoolDispatchTaskServiceDoesNotGuessEntryOrBypassTaskScope(t *testing.T) {
	cases := []struct {
		name string
		edit func(context.Context, *taskPoolFixture, *string, *string, *string) context.Context
	}{
		{"empty_entry", func(ctx context.Context, _ *taskPoolFixture, _, _, entry *string) context.Context {
			*entry = ""
			return ctx
		}},
		{"unknown_numeric_entry", func(ctx context.Context, _ *taskPoolFixture, _, _, entry *string) context.Context {
			*entry = "42"
			return ctx
		}},
		{"noncanonical_numeric_entry", func(ctx context.Context, f *taskPoolFixture, _, _, entry *string) context.Context {
			*entry = "0" + strconv.FormatInt(f.entryID, 10)
			return ctx
		}},
		{"zero_entry", func(ctx context.Context, _ *taskPoolFixture, _, _, entry *string) context.Context {
			*entry = "entry:00000000000000000000"
			return ctx
		}},
		{"wrong_step", func(ctx context.Context, _ *taskPoolFixture, _, step, _ *string) context.Context {
			*step = "pool-native-backlog"
			return ctx
		}},
		{"wrong_task", func(ctx context.Context, _ *taskPoolFixture, task, _, _ *string) context.Context {
			*task = "another-task"
			return ctx
		}},
		{"older_entry", func(ctx context.Context, f *taskPoolFixture, _, _, entry *string) context.Context {
			*entry = fmt.Sprintf("entry:%020d", f.entryID-1)
			return ctx
		}},
		{"unconfigured_queue", func(ctx context.Context, f *taskPoolFixture, _, _, _ *string) context.Context {
			f.publisher.SetPoolRunQueue(nil)
			return ctx
		}},
		{"outside_workspace", func(ctx context.Context, _ *taskPoolFixture, _, _, _ *string) context.Context {
			return authn.WithIdentity(ctx, authn.Identity{UserID: "outsider", Role: authn.RoleMember, SessionID: "other-browser"})
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newTaskPoolFixture(t)
			taskID, stepID, entry := f.task.ID, f.task.WorkflowStepID, fmt.Sprintf("entry:%020d", f.entryID)
			ctx := tc.edit(context.Background(), &f, &taskID, &stepID, &entry)
			outcome, err := f.publisher.PublishPoolRelease(ctx, taskID, stepID, entry)
			if err == nil || outcome != "" {
				t.Fatalf("不能猜最新阶段或绕过任务授权: outcome=%s err=%v", outcome, err)
			}
			var count int
			if err := f.database.Get(&count, `SELECT COUNT(*) FROM runs`); err != nil || count != 0 {
				t.Fatalf("拒绝不得产生原生运行: count=%d err=%v", count, err)
			}
		})
	}
}
