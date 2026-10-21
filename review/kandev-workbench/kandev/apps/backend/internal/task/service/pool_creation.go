package service

import (
	"context"
	"time"

	"github.com/kandev/kandev/internal/auth/authn"
	"github.com/kandev/kandev/internal/authz"
	"github.com/kandev/kandev/internal/steptelemetry"
	"github.com/kandev/kandev/internal/task/models"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
)

type poolCreationRelease struct {
	intent     models.PoolReleaseIntent
	version    time.Time
	externalID string
	creator    authn.Identity
}

type poolCreationRepository interface {
	CommitPoolTaskCreation(context.Context, string, time.Time, string) (bool, error)
}

func (s *Service) poolCreationContext(ctx context.Context, task *models.Task, req *CreateTaskRequest) (context.Context, error) {
	if req.PoolRelease == nil {
		return ctx, nil
	}
	if req.PoolRelease.ExpectedResourceVersion != "" {
		return nil, repoerrors.ErrTaskVersionConflict
	}
	if req.StartAgent || req.DeferredLaunch != nil {
		return nil, repoerrors.ErrPoolTaskNotAdmitted
	}
	if s.poolReleaseAdmission == nil || s.workflowStepGetter == nil {
		return nil, models.ErrPoolExecutionUnavailable
	}
	if _, ok := s.tasks.(poolCreationRepository); !ok {
		return nil, models.ErrPoolExecutionUnavailable
	}
	if task.Metadata == nil {
		task.Metadata = make(map[string]interface{})
	}
	if req.ExecutorID != "" {
		task.Metadata[models.MetaKeyExecutorID] = req.ExecutorID
	}
	if req.ExecutorProfileID != "" {
		task.Metadata[models.MetaKeyExecutorProfileID] = req.ExecutorProfileID
	}
	step, err := s.workflowStepGetter.GetStep(ctx, task.WorkflowStepID)
	if err != nil || step == nil {
		return nil, models.ErrPoolExecutionUnavailable
	}
	ctx, err = s.poolMoveContext(ctx, task, step, "", MoveTaskOptions{PoolRelease: req.PoolRelease})
	if err != nil {
		return nil, err
	}
	intent, _ := models.PoolReleaseIntentFromContext(ctx)
	intent.Creating, intent.DeferCreation = true, true
	return models.WithPoolReleaseIntent(ctx, intent), nil
}

// CompleteTaskCreation 只在所属请求的必要收尾完成后提交批准；丢失结果不授权重建批准。
func (s *Service) CompleteTaskCreation(ctx context.Context, result CreateTaskResult) (bool, *models.Task, error) {
	if result.poolCreation == nil {
		return s.SettleExternalID(ctx, result.Task.ID, result.Task.ExternalID)
	}
	grant := result.poolCreation
	identity, authenticated := authn.IdentityFromContext(ctx)
	if result.Outcome != CreateTaskOutcomeCreated || result.Task.ID != grant.intent.TaskID || !authenticated ||
		identity.UserID != grant.creator.UserID || identity.SessionID != grant.creator.SessionID {
		return false, nil, repoerrors.ErrPoolReleaseConfirmationRequired
	}
	if err := s.authorizeTaskScope(ctx, grant.intent.TaskID, authz.ScopeTaskWrite); err != nil {
		return false, nil, err
	}
	var settled bool
	err := s.withPoolReleaseAdmission(ctx, grant.intent.TaskID, &PoolReleaseConfirmation{}, func(admitted context.Context) error {
		intent := grant.intent
		intent.DeferCreation = false
		admitted = models.WithPoolReleaseIntent(admitted, intent)
		actorKind, actorID := steptelemetry.HumanOrSystemActor(admitted)
		admitted = steptelemetry.WithAttribution(admitted, steptelemetry.Attribution{Trigger: steptelemetry.TriggerTaskCreated,
			ActorKind: actorKind, ActorID: actorID})
		var err error
		settled, err = s.tasks.(poolCreationRepository).CommitPoolTaskCreation(admitted, intent.TaskID, grant.version, grant.externalID)
		return err
	})
	if err != nil || settled {
		return settled, nil, err
	}
	survivor, err := s.GetTask(ctx, grant.intent.TaskID)
	return false, survivor, err
}
