package service

import (
	"context"
	"errors"
	"testing"

	"github.com/kandev/kandev/internal/task/models"
)

func TestPoolDispatchNativeMoveRejectsUnsupportedExecutionBeforeCommit(t *testing.T) {
	cases := []struct {
		name string
		edit func(*poolMoveFixture) error
	}{
		{"missing_profile_reader", func(f *poolMoveFixture) error { f.svc.agentProfiles = nil; return nil }},
		{"missing_compatibility", func(f *poolMoveFixture) error { f.svc.agentProfileExecutorValidator = nil; return nil }},
		{"incompatible_executor", func(f *poolMoveFixture) error {
			f.svc.agentProfileExecutorValidator = poolExecutorCompatibility{err: errors.New("unsupported-native-runtime")}
			return nil
		}},
		{"disabled_profile", func(f *poolMoveFixture) error {
			_, err := f.database.Exec(`UPDATE agent_profiles SET enabled = 0 WHERE id = 'pool-native-cli'`)
			return err
		}},
		{"api_profile", func(f *poolMoveFixture) error {
			_, err := f.database.Exec(`UPDATE agent_profiles SET provider_kind = 'openai_compatible' WHERE id = 'pool-native-cli'`)
			return err
		}},
		{"auto_fallback", func(f *poolMoveFixture) error {
			_, err := f.database.Exec(`UPDATE agent_profiles SET auto_fallback = 1 WHERE id = 'pool-native-cli'`)
			return err
		}},
		{"fallback_model", func(f *poolMoveFixture) error {
			_, err := f.database.Exec(`UPDATE agent_profiles SET fallback_model = 'another-model' WHERE id = 'pool-native-cli'`)
			return err
		}},
		{"passthrough", func(f *poolMoveFixture) error {
			_, err := f.database.Exec(`UPDATE agent_profiles SET cli_passthrough = 1 WHERE id = 'pool-native-cli'`)
			return err
		}},
		{"indirect_profile", func(f *poolMoveFixture) error {
			_, err := f.database.Exec(`UPDATE agent_profiles SET execution_agent_profile_id = 'another-profile' WHERE id = 'pool-native-cli'`)
			return err
		}},
		{"unknown_family", func(f *poolMoveFixture) error {
			_, err := f.database.Exec(`UPDATE agents SET name = 'not-supported' WHERE id = 'pool-native-agent'`)
			return err
		}},
		{"other_workspace", func(f *poolMoveFixture) error {
			_, err := f.database.Exec(`UPDATE agent_profiles SET workspace_id = 'other-workspace' WHERE id = 'pool-native-cli'`)
			return err
		}},
		{"not_worktree", func(f *poolMoveFixture) error {
			f.task.Metadata[models.MetaKeyExecutorID] = models.ExecutorIDLocal
			if err := f.repo.UpdateTask(context.Background(), f.task); err != nil {
				return err
			}
			f.opts.PoolRelease.ExpectedResourceVersion = f.task.UpdatedAt.UTC().Format("2006-01-02T15:04:05.999999999Z07:00")
			return nil
		}},
		{"unconfigured_publisher", func(f *poolMoveFixture) error { f.publisher.SetPoolRunQueue(nil); return nil }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newPoolMoveFixture(t)
			if err := tc.edit(&f); err != nil {
				t.Fatal(err)
			}
			var before int
			if err := f.database.Get(&before, `SELECT COUNT(*) FROM task_step_transitions WHERE task_id = ?`, f.task.ID); err != nil {
				t.Fatal(err)
			}
			result, err := f.svc.MoveTaskWithOptions(f.ctx, f.task.ID, f.task.WorkflowID, f.step.ID, 0, f.opts)
			if err == nil || result != nil {
				t.Fatalf("不支持的池执行不能先提交卡片: result_present=%t err=%v", result != nil, err)
			}
			stored, err := f.repo.GetTask(context.Background(), f.task.ID)
			if err != nil || stored.WorkflowStepID != f.task.WorkflowStepID || !stored.UpdatedAt.Equal(f.task.UpdatedAt) {
				t.Fatalf("拒绝必须保留原卡和版本: %+v %v", stored, err)
			}
			var after int
			if err := f.database.Get(&after, `SELECT COUNT(*) FROM task_step_transitions WHERE task_id = ?`, f.task.ID); err != nil || after != before {
				t.Fatalf("拒绝不能追加批准账本: before=%d after=%d err=%v", before, after, err)
			}
		})
	}
}
