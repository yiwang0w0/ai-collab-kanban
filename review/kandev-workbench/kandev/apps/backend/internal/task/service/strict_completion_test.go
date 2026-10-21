package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/auth/authn"
	"github.com/kandev/kandev/internal/task/models"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
	sqliterepo "github.com/kandev/kandev/internal/task/repository/sqlite"
	wfmodels "github.com/kandev/kandev/internal/workflow/models"
	v1 "github.com/kandev/kandev/pkg/api/v1"
)

func strictFixture(t *testing.T) (context.Context, *Service, *sqliterepo.Repository) {
	t.Helper()
	ctx := authn.WithIdentity(context.Background(), authn.Identity{UserID: "fixture-human", Role: authn.RoleAdmin, Synthetic: true})
	svc, _, repo := createTestService(t)
	seedMoveWorkflows(t, ctx, repo)
	seedMoveSteps(svc)
	svc.workflowStepGetter.(*fakeWorkflowStepGetter).steps["step-done"] = &wfmodels.WorkflowStep{
		ID: "step-done", WorkflowID: "wf-source", Name: "Done", Position: 2, CompleteTaskOnEnter: true,
	}
	createMoveTask(t, ctx, repo, "strict-task", "wf-source", "step-source", nil)
	return ctx, svc, repo
}

func enableStrict(repo *sqliterepo.Repository) {
	repo.SetStrictCompletionPolicy(&sqliterepo.StrictCompletionPolicy{VerifierID: "plugin:fixture", Check: func(context.Context, string, string) error { return nil }})
}

func seedStrictCriterion(t *testing.T, ctx context.Context, svc *Service, repo *sqliterepo.Repository) string {
	t.Helper()
	task, err := repo.GetTask(ctx, "strict-task")
	if err != nil {
		t.Fatal(err)
	}
	_, err = svc.SetTaskCompletionCriteria(ctx, task.ID, SetTaskCompletionCriteriaRequest{ExpectedRevision: 0, Criteria: []models.TaskCompletionCriterion{{
		ID: sqliterepo.StrictCompletionCriterionID, Description: "交付验收", EvidenceSubject: models.TaskCompletionEvidenceSubject{Kind: models.TaskCompletionEvidenceArtifact, ID: task.ID},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	return task.UpdatedAt.UTC().Format(time.RFC3339Nano)
}

func TestStrictCompletionBlocksMissingGateAcrossEntryPoints(t *testing.T) {
	ctx, svc, repo := strictFixture(t)
	enableStrict(repo)
	if _, err := svc.MoveTask(ctx, "strict-task", "wf-source", "step-done", 0); !errors.Is(err, repoerrors.ErrTaskCompletionGateBlocked) {
		t.Fatalf("缺少验收条件仍能移动至 Done: %v", err)
	}
	if _, err := svc.UpdateTaskState(ctx, "strict-task", v1.TaskStateCompleted); !errors.Is(err, repoerrors.ErrTaskCompletionGateBlocked) {
		t.Fatalf("缺少回执仍能直接完成: %v", err)
	}
	if _, err := svc.BulkMoveSelectedTasks(ctx, []string{"strict-task"}, "wf-source", "step-done"); !errors.Is(err, repoerrors.ErrTaskCompletionGateBlocked) {
		t.Fatalf("批量选中移动绕过验收: %v", err)
	}
	if _, err := svc.BulkMoveTasks(ctx, "wf-source", "step-source", "wf-source", "step-done"); !errors.Is(err, repoerrors.ErrTaskCompletionGateBlocked) {
		t.Fatalf("整列移动绕过验收: %v", err)
	}
	task, err := repo.GetTask(ctx, "strict-task")
	if err != nil || task.State == v1.TaskStateCompleted {
		t.Fatalf("拒绝后任务被修改: %+v %v", task, err)
	}
}

func TestStrictCompletionRejectsNativeOverrideAndCriteriaRemoval(t *testing.T) {
	ctx, svc, repo := strictFixture(t)
	seedStrictCriterion(t, ctx, svc, repo)
	enableStrict(repo)
	_, err := svc.MoveTaskWithOptions(ctx, "strict-task", "wf-source", "step-done", 0, MoveTaskOptions{
		CompletionOverride: &TaskCompletionMoveOverrideRequest{ExpectedRevision: 1, Reason: "人工请求覆盖"},
	})
	if !errors.Is(err, repoerrors.ErrTaskCompletionGateBlocked) {
		t.Fatalf("人工覆盖绕过严格验收: %v", err)
	}
	_, err = svc.SetTaskCompletionCriteria(ctx, "strict-task", SetTaskCompletionCriteriaRequest{
		ExpectedRevision: 1, HumanConfirmation: &TaskCompletionHumanConfirmation{ExpectedRevision: 1, Reason: "删除条件"},
	})
	if !errors.Is(err, repoerrors.ErrTaskCompletionGateBlocked) {
		t.Fatalf("可以删除必需验收条件: %v", err)
	}
}

func TestStrictCompletionRejectsForgedNativeVerification(t *testing.T) {
	ctx, svc, repo := strictFixture(t)
	version := seedStrictCriterion(t, ctx, svc, repo)
	enableStrict(repo)
	_, err := svc.VerifyTaskCompletionCriterion(ctx, "strict-task", VerifyTaskCompletionCriterionRequest{
		ExpectedRevision: 1, CriterionID: sqliterepo.StrictCompletionCriterionID,
		Evidence: models.TaskCompletionEvidence{Subject: models.TaskCompletionEvidenceSubject{Kind: models.TaskCompletionEvidenceTaskRevision, ID: "strict-task", Revision: version}, Summary: "伪造通过"},
	})
	if !errors.Is(err, repoerrors.ErrTaskCompletionGateBlocked) {
		t.Fatalf("非指定插件可写入有效验证: %v", err)
	}
}

func approveStrictFixture(t *testing.T, ctx context.Context, svc *Service, repo *sqliterepo.Repository) {
	t.Helper()
	start := time.Now().UTC().Add(-time.Minute)
	for i, id := range []string{"implementation", "review"} {
		session := &models.TaskSession{ID: id, TaskID: "strict-task", State: models.TaskSessionStateWaitingForInput, StartedAt: start}
		if err := repo.CreateTaskSession(ctx, session); err != nil {
			t.Fatal(err)
		}
		turnStart := start.Add(time.Duration(i) * 10 * time.Second)
		end := turnStart.Add(time.Second)
		if err := repo.CreateTurn(ctx, &models.Turn{ID: id + "-turn", TaskID: "strict-task", TaskSessionID: id, StartedAt: turnStart, CompletedAt: &end}); err != nil {
			t.Fatal(err)
		}
	}
	task, err := repo.GetTask(ctx, "strict-task")
	if err != nil {
		t.Fatal(err)
	}
	version := task.UpdatedAt.UTC().Format(time.RFC3339Nano)
	actor := "plugin:fixture"
	fence := models.TaskManagementClaimFence{InstallationID: "fixture"}
	criteria, err := svc.SetTaskCompletionCriteriaExact(ctx, task.ID, ExactTaskCompletionCriteriaRequest{
		WorkspaceID: task.WorkspaceID, ExpectedTaskResourceVersion: version, OperationID: "strict-set",
		PayloadDigest: "sha256:" + strings.Repeat("a", 64), ActorID: actor, ClaimFence: fence,
		Criteria: []models.TaskCompletionCriterion{{ID: sqliterepo.StrictCompletionCriterionID, Description: "等待人工验收", EvidenceSubject: models.TaskCompletionEvidenceSubject{Kind: models.TaskCompletionEvidenceArtifact, ID: task.ID}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	implementation, _ := repo.GetTaskSession(ctx, "implementation")
	review, _ := repo.GetTaskSession(ctx, "review")
	summary, _ := json.Marshal(map[string]any{"format": "fleet-acceptance/v1", "task_id": task.ID, "task_resource_version": version, "actor_id": "fixture-human", "accepted_at": time.Now().UTC(), "implementation_session_id": "implementation", "review_session_id": "review", "implementation_resource_version": implementation.UpdatedAt.UTC().Format(time.RFC3339Nano), "review_resource_version": review.UpdatedAt.UTC().Format(time.RFC3339Nano)})
	_, err = svc.VerifyTaskCompletionCriterionExact(ctx, task.ID, ExactTaskCompletionEvidenceRequest{
		WorkspaceID: task.WorkspaceID, ExpectedTaskResourceVersion: version, ExpectedRevision: criteria.Snapshot.Revision,
		OperationID: "strict-verify", PayloadDigest: "sha256:" + strings.Repeat("b", 64), ActorID: actor, ClaimFence: fence,
		CriterionID: sqliterepo.StrictCompletionCriterionID, Evidence: models.TaskCompletionEvidence{
			Subject: models.TaskCompletionEvidenceSubject{Kind: models.TaskCompletionEvidenceArtifact, ID: task.ID, Revision: "candidate-1"}, Summary: string(summary),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestStrictCompletionAllowsOnlyFreshTrustedReceipt(t *testing.T) {
	for _, scenario := range []string{"有效", "文件变化", "任务变化", "会话变化", "审查顺序错误", "执行仍活动", "校验器缺失", "新一轮执行"} {
		t.Run(scenario, func(t *testing.T) {
			ctx, svc, repo := strictFixture(t)
			enableStrict(repo)
			approveStrictFixture(t, ctx, svc, repo)
			switch scenario {
			case "会话变化":
				session, _ := repo.GetTaskSession(ctx, "review")
				session.Name = "变更后的审查会话"
				if err := repo.UpdateTaskSession(ctx, session); err != nil {
					t.Fatal(err)
				}
			case "审查顺序错误":
				if _, err := repo.DB().ExecContext(ctx, `UPDATE task_session_turns SET started_at = ? WHERE id = ?`, time.Now().UTC().Add(-2*time.Minute), "review-turn"); err != nil {
					t.Fatal(err)
				}
			case "执行仍活动":
				if err := repo.CreateTaskSession(ctx, &models.TaskSession{ID: "other-active", TaskID: "strict-task", State: models.TaskSessionStateRunning, StartedAt: time.Now().UTC()}); err != nil {
					t.Fatal(err)
				}
			case "新一轮执行":
				if err := repo.CreateTurn(ctx, &models.Turn{ID: "new-turn", TaskID: "strict-task", TaskSessionID: "implementation", StartedAt: time.Now().UTC()}); err != nil {
					t.Fatal(err)
				}
			case "文件变化":
				repo.SetStrictCompletionPolicy(&sqliterepo.StrictCompletionPolicy{VerifierID: "plugin:fixture", Check: func(context.Context, string, string) error { return errors.New("stale") }})
			case "校验器缺失":
				repo.SetStrictCompletionPolicy(&sqliterepo.StrictCompletionPolicy{VerifierID: "plugin:fixture"})
			case "任务变化":
				task, _ := repo.GetTask(ctx, "strict-task")
				task.Title = "已更新任务"
				if err := repo.UpdateTask(ctx, task); err != nil {
					t.Fatal(err)
				}
			}
			var err error
			if scenario == "执行仍活动" {
				// 直接测持久化门禁，不以服务层原有的活动会话检查代替。
				err = repo.UpdateTaskState(ctx, "strict-task", v1.TaskStateCompleted)
			} else {
				_, err = svc.MoveTask(ctx, "strict-task", "wf-source", "step-done", 0)
			}
			if scenario == "有效" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if !errors.Is(err, repoerrors.ErrTaskCompletionGateBlocked) {
				t.Fatalf("陈旧或不可测回执仍可完成: %v", err)
			}
		})
	}
}

func TestStrictCompletionRejectsCompletedCreationAndPluginWeakening(t *testing.T) {
	ctx, svc, repo := strictFixture(t)
	enableStrict(repo)
	task, _ := repo.GetTask(ctx, "strict-task")
	task.ID = "forged-done"
	task.State = v1.TaskStateCompleted
	if err := repo.CreateTask(ctx, task); !errors.Is(err, repoerrors.ErrTaskCompletionGateBlocked) {
		t.Fatalf("可以直接创建已完成任务: %v", err)
	}
	approveStrictFixture(t, ctx, svc, repo)
	task, _ = repo.GetTask(ctx, "strict-task")
	_, err := svc.SetTaskCompletionCriteriaExact(ctx, task.ID, ExactTaskCompletionCriteriaRequest{
		WorkspaceID: task.WorkspaceID, ExpectedTaskResourceVersion: task.UpdatedAt.UTC().Format(time.RFC3339Nano), ExpectedRevision: 1,
		OperationID: "strict-remove", PayloadDigest: "sha256:" + strings.Repeat("c", 64), ActorID: "plugin:fixture", ClaimFence: models.TaskManagementClaimFence{InstallationID: "fixture"},
	})
	if !errors.Is(err, repoerrors.ErrTaskCompletionGateBlocked) {
		t.Fatalf("指定插件也不能移除必需条件: %v", err)
	}
}
