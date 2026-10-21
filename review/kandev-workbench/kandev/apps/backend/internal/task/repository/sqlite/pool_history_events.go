package sqlite

import (
	"context"

	"github.com/jmoiron/sqlx"
	"github.com/kandev/kandev/internal/task/poolhistory"
)

func (r *Repository) loadPoolHistoryEvents(ctx context.Context, tx *sqlx.Tx, snapshot *poolhistory.Snapshot) error {
	runIDs, claimIDs := make([]string, 0, len(snapshot.Selections)), make([]string, 0, len(snapshot.Selections))
	seen := make(map[string]bool)
	for _, selection := range snapshot.Selections {
		if selection.RunID == "" {
			continue
		}
		claimIDs = append(claimIDs, selection.ClaimID)
		if !seen[selection.RunID] {
			seen[selection.RunID] = true
			runIDs = append(runIDs, selection.RunID)
		}
	}
	if len(runIDs) == 0 {
		return nil
	}
	maximum := max(len(runIDs), len(claimIDs)) * 16
	query, args, err := sqlx.In(`SELECT e.run_id,e.seq,e.event_type,e.created_at,
		CASE WHEN length(CAST(payload AS BLOB))<=16384 THEN payload ELSE '' END AS payload
		FROM run_events e WHERE e.run_id IN (?) AND e.event_type LIKE 'pool.%' AND `+
		poolCausalEventScopeSQL+` ORDER BY e.run_id,e.seq LIMIT ?`, runIDs, claimIDs, claimIDs, maximum+1)
	if err != nil {
		return err
	}
	if err := tx.SelectContext(ctx, &snapshot.Events, tx.Rebind(query), args...); err != nil {
		return err
	}
	snapshot.EvidenceIncomplete = len(snapshot.Events) > maximum
	return nil
}
