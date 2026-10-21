package sqlite

import (
	"context"

	"github.com/jmoiron/sqlx"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/kandev/kandev/internal/task/poolhistory"
)

func (r *Repository) loadPoolHistoryRuns(ctx context.Context, tx *sqlx.Tx, snapshot *poolhistory.Snapshot) error {
	keys := make([]string, 0, len(snapshot.Entries))
	for _, entry := range snapshot.Entries {
		key, err := (runsmodels.PoolReleaseSnapshot{WorkspaceID: snapshot.WorkspaceID, TaskID: snapshot.TaskID, EntryID: entry.ID}).DispatchKey()
		if err != nil {
			return err
		}
		keys = append(keys, key)
	}
	rows, incomplete, err := readPoolHistoryRunCandidates(ctx, tx, keys)
	if err != nil {
		return err
	}
	snapshot.Runs, snapshot.Incomplete = rows, incomplete
	snapshot.Clearances, err = readPoolHistoryClearances(ctx, tx, keys)
	return err
}

func readPoolHistoryRunCandidates(ctx context.Context, tx *sqlx.Tx, keys []string) ([]*runsmodels.Run, bool, error) {
	if len(keys) == 0 {
		return nil, false, nil
	}
	query, args, err := sqlx.In(`SELECT id,workspace_id,agent_profile_id,reason,status,idempotency_key,
		actor_kind,actor_id,coalesced_count,wake_wave_key,wake_wave_string,requested_at,claimed_at,finished_at,outcome,
		COALESCE(session_id,'') AS session_id,
		CASE WHEN length(COALESCE(cancel_reason,''))<=256 THEN COALESCE(cancel_reason,'') ELSE '' END AS cancel_reason,
		CASE WHEN length(CAST(payload AS BLOB))<=16384 THEN payload ELSE '' END AS payload
		FROM runs WHERE idempotency_key IN (?) ORDER BY id LIMIT ?`, keys, len(keys)*2+1)
	if err != nil {
		return nil, false, err
	}
	var rows []*runsmodels.Run
	if err := tx.SelectContext(ctx, &rows, tx.Rebind(query), args...); err != nil {
		return nil, false, err
	}
	return rows, len(rows) > len(keys)*2, nil
}

func (r *Repository) loadPoolHistoryClaimCounts(ctx context.Context, tx *sqlx.Tx, snapshot *poolhistory.Snapshot, seeds []poolhistory.Seed) error {
	ids := make([]string, 0, len(seeds))
	for _, seed := range seeds {
		if seed.RunID != "" {
			ids = append(ids, seed.RunID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	query, args, err := sqlx.In(`SELECT l.run_id,COUNT(*) AS total,
		SUM(CASE WHEN l.claimed_at=r.claimed_at THEN 1 ELSE 0 END) AS current_matches
		FROM office_launch_ledger l LEFT JOIN runs r ON r.id=l.run_id WHERE l.run_id IN (?) GROUP BY l.run_id`, ids)
	if err != nil {
		return err
	}
	return tx.SelectContext(ctx, &snapshot.ClaimCounts, tx.Rebind(query), args...)
}
