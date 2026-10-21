package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"

	"github.com/kandev/kandev/internal/task/models"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
	v1 "github.com/kandev/kandev/pkg/api/v1"
)

func (r *Repository) checkPoolExecutionCandidateTx(ctx context.Context, tx stepTransitionTx, taskID, workspaceID, profileID string) error {
	return r.checkPoolExecutionCandidateForRetryTx(ctx, tx, taskID, workspaceID, profileID, false)
}

func (r *Repository) checkPoolExecutionCandidateForRetryTx(ctx context.Context, tx stepTransitionTx, taskID, workspaceID, profileID string, verifiedRetry bool) error {
	choice, err := r.poolProfileCandidateTx(ctx, tx, workspaceID, profileID)
	if err != nil {
		return err
	}
	executorID, err := r.poolTaskExecutorIDTx(ctx, tx, taskID, workspaceID, profileID, verifiedRetry)
	if err != nil {
		return err
	}
	var deleted bool
	err = tx.QueryRowContext(ctx, r.db.Rebind(`SELECT type, status, deleted_at IS NOT NULL FROM executors WHERE id = ?`),
		executorID).Scan(&choice.ExecutorType, &choice.ExecutorStatus, &deleted)
	if err != nil || deleted {
		return models.ErrPoolExecutionUnavailable
	}
	return choice.Validate()
}

func (r *Repository) poolProfileCandidateTx(ctx context.Context, tx stepTransitionTx, workspaceID, profileID string) (models.PoolExecutionCandidate, error) {
	choice := models.PoolExecutionCandidate{WorkspaceID: workspaceID}
	var tuiConfig string
	err := tx.QueryRowContext(ctx, r.db.Rebind(`SELECT p.id, p.agent_id, a.id, a.name,
		COALESCE(p.workspace_id, ''), COALESCE(a.workspace_id, ''), COALESCE(p.enabled, 0), p.deleted_at IS NOT NULL,
		COALESCE(p.provider_kind, ''), COALESCE(p.auto_fallback, 1), COALESCE(p.fallback_model, ''),
		COALESCE(p.cli_passthrough, 0), COALESCE(p.execution_agent_profile_id, ''), COALESCE(a.tui_config, '')
		FROM agent_profiles p JOIN agents a ON a.id = p.agent_id WHERE p.id = ?`), profileID).Scan(
		&choice.AgentProfileID, &choice.ProfileAgentRecordID, &choice.AgentRecordID, &choice.AgentFamily,
		&choice.ProfileWorkspaceID, &choice.AgentWorkspaceID, &choice.Enabled, &choice.Deleted, &choice.ProviderKind,
		&choice.AutoFallback, &choice.FallbackModel, &choice.CLIPassthrough, &choice.ExecutionAgentProfileID, &tuiConfig)
	if err != nil {
		return choice, models.ErrPoolExecutionUnavailable
	}
	tuiConfig = strings.TrimSpace(tuiConfig)
	choice.CustomTUI = tuiConfig != "" && tuiConfig != "null"
	return choice, nil
}

func (r *Repository) poolTaskExecutorIDTx(ctx context.Context, tx stepTransitionTx, taskID, workspaceID, profileID string, verifiedRetry bool) (string, error) {
	var rawMetadata, rawOverrides, workflowID, stepID, defaultExecutor string
	var state v1.TaskState
	err := tx.QueryRowContext(ctx, r.db.Rebind(`SELECT t.metadata, COALESCE(t.workflow_agent_overrides, ''),
		t.workflow_id, t.workflow_step_id, t.state, COALESCE(w.default_executor_id, '')
		FROM tasks t JOIN workspaces w ON w.id = t.workspace_id WHERE t.id = ? AND t.workspace_id = ?`), taskID, workspaceID).Scan(
		&rawMetadata, &rawOverrides, &workflowID, &stepID, &state, &defaultExecutor)
	if err != nil {
		return "", repoerrors.ErrPoolTaskNotAdmitted
	}
	if state != v1.TaskStateTODO && state != v1.TaskStateCreated && state != v1.TaskStateReview &&
		state != v1.TaskStateBlocked && state != v1.TaskStateWaitingForInput && !(verifiedRetry && state == v1.TaskStateInProgress) {
		return "", repoerrors.ErrPoolTaskNotAdmitted
	}
	var metadata map[string]any
	if json.Unmarshal([]byte(rawMetadata), &metadata) != nil || metadata[models.MetaKeyDeferredLaunch] != nil {
		return "", repoerrors.ErrPoolTaskNotAdmitted
	}
	overrides, err := models.DecodeWorkflowAgentOverrides(rawOverrides)
	if err != nil {
		return "", models.ErrPoolExecutionUnavailable
	}
	if replacement, bound := overrides.ReplacementFor(workflowID, stepID); bound && replacement != profileID {
		return "", models.ErrPoolExecutionUnavailable
	}
	return r.poolExecutorSelectionTx(ctx, tx, metadata, defaultExecutor)
}

func (r *Repository) poolExecutorSelectionTx(ctx context.Context, tx stepTransitionTx, metadata map[string]any, defaultExecutor string) (string, error) {
	for _, key := range []string{models.MetaKeyExecutorID, models.MetaKeyExecutorProfileID} {
		if value := metadata[key]; value != nil {
			if _, ok := value.(string); !ok {
				return "", models.ErrPoolExecutionUnavailable
			}
		}
	}
	executorID := strings.TrimSpace(models.StringFromAny(metadata[models.MetaKeyExecutorID]))
	profileID := strings.TrimSpace(models.StringFromAny(metadata[models.MetaKeyExecutorProfileID]))
	if profileID != "" {
		var profileExecutorID string
		if err := tx.QueryRowContext(ctx, r.db.Rebind(`SELECT executor_id FROM executor_profiles WHERE id = ?`), profileID).Scan(&profileExecutorID); err != nil ||
			profileExecutorID == "" || (executorID != "" && executorID != profileExecutorID) {
			return "", models.ErrPoolExecutionUnavailable
		}
		executorID = profileExecutorID
	}
	if executorID == "" {
		executorID = strings.TrimSpace(defaultExecutor)
	}
	if executorID == "" {
		return "", sql.ErrNoRows
	}
	return executorID, nil
}
