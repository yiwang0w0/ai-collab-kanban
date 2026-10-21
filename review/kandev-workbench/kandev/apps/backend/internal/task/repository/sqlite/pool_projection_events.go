package sqlite

import (
	"context"

	"github.com/jmoiron/sqlx"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/kandev/kandev/internal/task/poolhistory"
	"github.com/kandev/kandev/internal/task/poolview"
)

func loadPoolProjectionEvents(ctx context.Context, tx *sqlx.Tx, snapshot *poolview.Snapshot) error {
	runs, claims, owners := poolProjectionEventScopes(snapshot)
	if len(runs) == 0 {
		return nil
	}
	query, args, err := sqlx.In(`WITH evidence AS (
		SELECT e.run_id,e.seq,e.event_type,e.created_at,
		CASE WHEN length(CAST(payload AS BLOB))<=16384 THEN payload ELSE '' END AS payload,
		ROW_NUMBER() OVER (PARTITION BY e.run_id ORDER BY e.seq) AS ordinal
		FROM run_events e WHERE e.run_id IN (?) AND e.event_type LIKE 'pool.%' AND `+
		poolCausalEventScopeSQL+`
	) SELECT run_id,seq,event_type,created_at,payload FROM evidence WHERE ordinal<=17 ORDER BY run_id,seq`, runs, claims, claims)
	if err != nil {
		return err
	}
	var rows []*runsmodels.RunEvent
	if err := tx.SelectContext(ctx, &rows, tx.Rebind(query), args...); err != nil {
		return err
	}
	for _, row := range rows {
		history := owners[row.RunID]
		history.Events = append(history.Events, row)
		history.EvidenceIncomplete = len(history.Events) > 16
	}
	return nil
}

func poolProjectionEventScopes(snapshot *poolview.Snapshot) ([]string, []string, map[string]*poolhistory.Snapshot) {
	runs, claims, owners := make([]string, 0), make([]string, 0), make(map[string]*poolhistory.Snapshot)
	for _, history := range snapshot.Histories {
		for _, selection := range history.Selections {
			if selection.RunID != "" {
				runs, claims, owners[selection.RunID] = append(runs, selection.RunID), append(claims, selection.ClaimID), history
			}
		}
	}
	return runs, claims, owners
}
