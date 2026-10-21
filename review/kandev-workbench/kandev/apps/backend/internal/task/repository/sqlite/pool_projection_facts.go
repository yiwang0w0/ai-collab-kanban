package sqlite

import (
	"context"
	"time"

	"github.com/jmoiron/sqlx"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/kandev/kandev/internal/steptelemetry"
	"github.com/kandev/kandev/internal/task/poolhistory"
	"github.com/kandev/kandev/internal/task/poolview"
)

type poolProjectionEntry struct {
	poolhistory.Entry
	TaskID        string    `db:"task_id"`
	LatestEntryID int64     `db:"latest_entry_id"`
	ActivatedAt   time.Time `db:"activated_at"`
}

func (r *Repository) loadPoolProjectionFacts(ctx context.Context, tx *sqlx.Tx, snapshot *poolview.Snapshot) error {
	if len(snapshot.Cards) == 0 {
		return nil
	}
	if err := loadPoolProjectionContexts(ctx, tx, snapshot); err != nil {
		return err
	}
	return r.loadPoolProjectionEvidence(ctx, tx, snapshot)
}

func (r *Repository) loadPoolProjectionEvidence(ctx context.Context, tx *sqlx.Tx, snapshot *poolview.Snapshot) error {
	if len(snapshot.Cards) == 0 {
		return nil
	}
	if err := loadPoolProjectionEntries(ctx, tx, snapshot); err != nil {
		return err
	}
	if err := loadPoolProjectionRuns(ctx, tx, snapshot); err != nil {
		return err
	}
	if err := r.loadPoolProjectionClaims(ctx, tx, snapshot); err != nil {
		return err
	}
	return loadPoolProjectionEvents(ctx, tx, snapshot)
}

func loadPoolProjectionEntries(ctx context.Context, tx *sqlx.Tx, snapshot *poolview.Snapshot) error {
	ids, cards := make([]string, 0, len(snapshot.Cards)), make(map[string]poolview.Card, len(snapshot.Cards))
	for _, card := range snapshot.Cards {
		ids, cards[card.TaskID] = append(ids, card.TaskID), card
	}
	query, args, err := sqlx.In(`SELECT l.task_id,l.id,
		(SELECT activated_at FROM run_pool_history_policy WHERE version=1) AS activated_at,
		(SELECT MAX(latest.id) FROM task_step_transitions latest WHERE latest.task_id=l.task_id) AS latest_entry_id,
		COALESCE(l.to_workflow_id,'') AS workflow_id,
		COALESCE(l.to_workflow_step_id,'') AS step_id,l.actor_kind,COALESCE(l.actor_id,'') AS actor_id,
		l.contract_version,l.occurred_at,CASE WHEN s.updated_at<=l.occurred_at AND length(COALESCE(s.agent_profile_id,''))<=256
		THEN COALESCE(s.agent_profile_id,'') ELSE '' END AS planned_profile
		FROM task_step_transitions l LEFT JOIN workflow_steps s ON s.id=l.to_workflow_step_id AND s.workflow_id=l.to_workflow_id
		WHERE l.task_id IN (?) AND l.trigger=? AND l.id=(SELECT MAX(released.id) FROM task_step_transitions released
		WHERE released.task_id=l.task_id AND released.trigger=l.trigger)`,
		ids, steptelemetry.TriggerPoolRelease)
	if err != nil {
		return err
	}
	var rows []poolProjectionEntry
	if err := tx.SelectContext(ctx, &rows, tx.Rebind(query), args...); err != nil {
		return err
	}
	snapshot.Histories = make(map[string]*poolhistory.Snapshot, len(rows))
	for _, row := range rows {
		card := cards[row.TaskID]
		snapshot.Histories[row.TaskID] = &poolhistory.Snapshot{TaskID: row.TaskID, WorkspaceID: snapshot.WorkspaceID,
			Entries: []poolhistory.Entry{row.Entry}, LatestEntryID: row.LatestEntryID, PolicyActivatedAt: row.ActivatedAt,
			CurrentWorkflowID: card.WorkflowID, CurrentStepID: card.WorkflowStepID}
	}
	return nil
}

func loadPoolProjectionRuns(ctx context.Context, tx *sqlx.Tx, snapshot *poolview.Snapshot) error {
	keys, owners := make([]string, 0, len(snapshot.Histories)), make(map[string]*poolhistory.Snapshot, len(snapshot.Histories))
	for taskID, history := range snapshot.Histories {
		key, err := (runsmodels.PoolReleaseSnapshot{WorkspaceID: snapshot.WorkspaceID, TaskID: taskID, EntryID: history.Entries[0].ID}).DispatchKey()
		if err != nil {
			return err
		}
		keys, owners[key] = append(keys, key), history
	}
	rows, incomplete, err := readPoolHistoryRunCandidates(ctx, tx, keys)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if row.IdempotencyKey != nil && owners[*row.IdempotencyKey] != nil {
			history := owners[*row.IdempotencyKey]
			history.Runs = append(history.Runs, row)
		}
	}
	clearances, err := readPoolHistoryClearances(ctx, tx, keys)
	if err != nil {
		return err
	}
	for _, clearance := range clearances {
		if history := owners[clearance.DispatchKey]; history != nil {
			history.Clearances = append(history.Clearances, clearance)
		}
	}
	for _, history := range snapshot.Histories {
		history.Incomplete = incomplete
	}
	return nil
}
