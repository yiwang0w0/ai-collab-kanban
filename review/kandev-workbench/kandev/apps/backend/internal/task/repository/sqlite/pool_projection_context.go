package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"

	"github.com/jmoiron/sqlx"
	"github.com/kandev/kandev/internal/task/models"
	"github.com/kandev/kandev/internal/task/poolview"
	wfmodels "github.com/kandev/kandev/internal/workflow/models"
	v1 "github.com/kandev/kandev/pkg/api/v1"
)

type poolProjectionContextRow struct {
	poolview.Relations
	TaskID                  string         `db:"task_id"`
	DependenciesBlocked     bool           `db:"dependencies_blocked"`
	WIPAdmitted             bool           `db:"wip_admitted"`
	QueuedForStep           bool           `db:"queued_for_step"`
	StepID                  string         `db:"step_id"`
	StepUpdatedAt           sql.NullTime   `db:"step_updated_at"`
	StepProfileID           string         `db:"step_profile_id"`
	StepEvents              string         `db:"step_events"`
	SessionTarget           sql.NullString `db:"session_target"`
	CompleteTaskOnEnter     bool           `db:"complete_task_on_enter"`
	ProfileID               string         `db:"profile_id"`
	ProfileAgentID          string         `db:"profile_agent_id"`
	AgentID                 string         `db:"agent_id"`
	AgentFamily             string         `db:"agent_family"`
	ProfileWorkspaceID      string         `db:"profile_workspace_id"`
	AgentWorkspaceID        string         `db:"agent_workspace_id"`
	Enabled                 bool           `db:"enabled"`
	Deleted                 bool           `db:"deleted"`
	ProviderKind            string         `db:"provider_kind"`
	AutoFallback            bool           `db:"auto_fallback"`
	FallbackModel           string         `db:"fallback_model"`
	CLIPassthrough          bool           `db:"cli_passthrough"`
	ExecutionAgentProfileID string         `db:"execution_agent_profile_id"`
	TUIConfig               string         `db:"tui_config"`
}

func loadPoolProjectionContexts(ctx context.Context, tx *sqlx.Tx, snapshot *poolview.Snapshot) error {
	ids := make([]string, 0, len(snapshot.Cards))
	for _, card := range snapshot.Cards {
		ids = append(ids, card.TaskID)
	}
	query, args, err := sqlx.In(poolProjectionContextSQL, v1.TaskStateCompleted, ids, snapshot.WorkspaceID)
	if err != nil {
		return err
	}
	var rows []poolProjectionContextRow
	if err := tx.SelectContext(ctx, &rows, tx.Rebind(query), args...); err != nil {
		return err
	}
	snapshot.Contexts = make(map[string]poolview.CardContext, len(rows))
	for _, row := range rows {
		snapshot.Contexts[row.TaskID] = row.context(snapshot.WorkspaceID)
	}
	return nil
}

func (row poolProjectionContextRow) context(workspaceID string) poolview.CardContext {
	step := &wfmodels.WorkflowStep{ID: row.StepID, AgentProfileID: row.StepProfileID, CompleteTaskOnEnter: row.CompleteTaskOnEnter}
	if row.SessionTarget.Valid && row.SessionTarget.String != "" && row.SessionTarget.String != "null" {
		step.SessionTarget = &wfmodels.WorkflowSessionTarget{}
	}
	var decodeError error
	if row.StepEvents != "" {
		decodeError = json.Unmarshal([]byte(row.StepEvents), &step.Events)
	}
	_, configured, configError := step.PoolExecutionProfile()
	tui := strings.TrimSpace(row.TUIConfig)
	return poolview.CardContext{Relations: row.Relations, DependenciesBlocked: row.DependenciesBlocked,
		StepExists: row.StepID != "", StepUpdatedAt: row.StepUpdatedAt.Time,
		PoolConfigured: configured, InvalidPoolConfig: decodeError != nil || configError != nil,
		WIPAdmitted: row.WIPAdmitted, QueuedForStep: row.QueuedForStep,
		Profile: models.PoolExecutionCandidate{WorkspaceID: workspaceID, AgentProfileID: row.ProfileID,
			ProfileAgentRecordID: row.ProfileAgentID, AgentRecordID: row.AgentID, AgentFamily: row.AgentFamily,
			ProfileWorkspaceID: row.ProfileWorkspaceID, AgentWorkspaceID: row.AgentWorkspaceID, Enabled: row.Enabled,
			Deleted: row.Deleted, ProviderKind: row.ProviderKind, AutoFallback: row.AutoFallback, FallbackModel: row.FallbackModel,
			CLIPassthrough: row.CLIPassthrough, ExecutionAgentProfileID: row.ExecutionAgentProfileID, CustomTUI: tui != "" && tui != "null"}}
}
