package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/kandev/kandev/internal/auth/authn"
	"github.com/kandev/kandev/internal/db/dialect"
	"github.com/kandev/kandev/internal/steptelemetry"
	"github.com/kandev/kandev/internal/task/models"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
	wfmodels "github.com/kandev/kandev/internal/workflow/models"
)

func (r *Repository) guardPoolStepEntryTx(ctx context.Context, tx stepTransitionTx, in stepTransitionInput) error {
	if in.toWorkflowStepID == "" {
		return nil
	}
	step, err := r.poolStepInTx(ctx, tx, in.toWorkflowStepID)
	if err != nil {
		return err
	}
	_, pool, err := step.PoolExecutionProfile()
	if err != nil {
		return err
	}
	intent, confirmed := models.PoolReleaseIntentFromContext(ctx)
	if !pool {
		if confirmed {
			return wfmodels.ErrInvalidPoolStep
		}
		return nil
	}
	if dialect.IsPostgres(r.db.DriverName()) {
		return repoerrors.ErrPoolStorageUnsupported
	}
	if err := validatePoolReleaseIntent(ctx, intent, confirmed, in, step); err != nil {
		return err
	}
	var taskWorkspace, workflowWorkspace string
	if err := tx.QueryRowContext(ctx, r.db.Rebind(`SELECT t.workspace_id, w.workspace_id FROM tasks t
		JOIN workflows w ON w.id = ? WHERE t.id = ? AND t.archived_at IS NULL AND t.is_ephemeral = 0
		  AND t.wip_admitted = 1 AND COALESCE(t.queued_for_step_id, '') = ''`), in.toWorkflowID, in.taskID).Scan(&taskWorkspace, &workflowWorkspace); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return repoerrors.ErrPoolTaskNotAdmitted
		}
		return err
	}
	if intent.WorkspaceID == "" || intent.WorkspaceID != taskWorkspace || taskWorkspace != workflowWorkspace {
		return repoerrors.ErrPoolReleaseConfirmationRequired
	}
	return r.checkPoolTaskReadyTx(ctx, tx, in.taskID, taskWorkspace, step.AgentProfileID, "")
}

func validatePoolReleaseIntent(ctx context.Context, intent models.PoolReleaseIntent, confirmed bool,
	in stepTransitionInput, step *wfmodels.WorkflowStep) error {
	if !confirmed || !intent.ConfirmCLIQuota || !validPoolReleaseActor(ctx) || intent.TaskID != in.taskID ||
		intent.StepID != in.toWorkflowStepID || intent.WorkflowID != in.toWorkflowID || intent.WorkflowID != step.WorkflowID {
		return repoerrors.ErrPoolReleaseConfirmationRequired
	}
	if intent.Creating {
		if in.fromWorkflowStepID != "" || intent.ExpectedResourceVersion != "" {
			return repoerrors.ErrPoolReleaseConfirmationRequired
		}
	} else if _, err := time.Parse(time.RFC3339Nano, intent.ExpectedResourceVersion); err != nil {
		return repoerrors.ErrTaskVersionConflict
	}
	return validatePoolReleaseStepVersion(intent, step)
}

func validatePoolReleaseStepVersion(intent models.PoolReleaseIntent, step *wfmodels.WorkflowStep) error {
	expected, err := time.Parse(time.RFC3339Nano, intent.ExpectedStepVersion)
	if err != nil || !expected.Equal(step.UpdatedAt) || intent.ExpectedAgentProfileID != step.AgentProfileID {
		return repoerrors.ErrPoolStepChanged
	}
	return nil
}

func validPoolReleaseActor(ctx context.Context) bool {
	identity, ok := authn.IdentityFromContext(ctx)
	if !ok || identity.Synthetic || strings.TrimSpace(identity.UserID) == "" || identity.SessionID == "" || identity.TokenID != "" {
		return false
	}
	actor := steptelemetry.FromContext(ctx)
	return actor.ActorKind == steptelemetry.ActorHuman && actor.ActorID == identity.UserID && actor.SessionID == "" &&
		(actor.Trigger == steptelemetry.TriggerManualMove || actor.Trigger == steptelemetry.TriggerTaskCreated)
}

func validatePoolReleaseSourceVersion(ctx context.Context, taskID, currentStepID string, updatedAt time.Time) error {
	intent, ok := models.PoolReleaseIntentFromContext(ctx)
	if !ok {
		return nil
	}
	if intent.TaskID != taskID || intent.Creating {
		return repoerrors.ErrPoolReleaseConfirmationRequired
	}
	// 已提交的目标阶段不能因时钟重复而再次消费旧批准；发布重放另走持久派发身份。
	if intent.StepID == currentStepID {
		return repoerrors.ErrTaskVersionConflict
	}
	expected, err := time.Parse(time.RFC3339Nano, intent.ExpectedResourceVersion)
	if err != nil || !expected.Equal(updatedAt) {
		return repoerrors.ErrTaskVersionConflict
	}
	return nil
}

func (r *Repository) poolStepInTx(ctx context.Context, tx stepTransitionTx, stepID string) (*wfmodels.WorkflowStep, error) {
	step := &wfmodels.WorkflowStep{ID: stepID}
	var events string
	var sessionTarget sql.NullString
	err := tx.QueryRowContext(ctx, r.db.Rebind(`SELECT workflow_id, COALESCE(events, '{}'),
		COALESCE(agent_profile_id, ''), complete_task_on_enter, session_target, updated_at
		FROM workflow_steps WHERE id = ?`), stepID).Scan(&step.WorkflowID, &events,
		&step.AgentProfileID, &step.CompleteTaskOnEnter, &sessionTarget, &step.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if events != "" {
		if err := json.Unmarshal([]byte(events), &step.Events); err != nil {
			return nil, wfmodels.ErrInvalidPoolStep
		}
	}
	if sessionTarget.Valid && sessionTarget.String != "" && sessionTarget.String != "null" {
		step.SessionTarget = &wfmodels.WorkflowSessionTarget{}
	}
	return step, nil
}
