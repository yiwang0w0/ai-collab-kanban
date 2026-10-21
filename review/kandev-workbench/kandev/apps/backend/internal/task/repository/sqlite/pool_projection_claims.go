package sqlite

import (
	"context"

	"github.com/jmoiron/sqlx"
	"github.com/kandev/kandev/internal/task/poolhistory"
	"github.com/kandev/kandev/internal/task/poolview"
)

func (r *Repository) loadPoolProjectionClaims(ctx context.Context, tx *sqlx.Tx, snapshot *poolview.Snapshot) error {
	seeds, owners := make([]poolhistory.Seed, 0, len(snapshot.Histories)), make(map[string]*poolhistory.Snapshot, len(snapshot.Histories))
	for _, history := range snapshot.Histories {
		for _, seed := range poolhistory.SelectionSeeds(history) {
			history.Selections = []poolhistory.Selection{{EntryID: seed.EntryID, RunID: seed.RunID}}
			if seed.RunID != "" {
				seeds, owners[seed.RunID] = append(seeds, seed), history
			}
		}
	}
	combined := &poolhistory.Snapshot{}
	if err := r.loadPoolHistoryClaimCounts(ctx, tx, combined, seeds); err != nil {
		return err
	}
	for _, count := range combined.ClaimCounts {
		owners[count.RunID].ClaimCounts = []poolhistory.ClaimCount{count}
	}
	ids := make([]string, 0, len(owners))
	for id := range owners {
		ids = append(ids, id)
	}
	return loadPoolProjectionCurrentClaims(ctx, tx, ids, owners)
}

func loadPoolProjectionCurrentClaims(ctx context.Context, tx *sqlx.Tx, ids []string, owners map[string]*poolhistory.Snapshot) error {
	if len(ids) == 0 {
		return nil
	}
	query, args, err := sqlx.In(`WITH matching AS (
		SELECT l.run_id,l.id AS claim_id,l.workspace_id,l.claimed_at,
		ROW_NUMBER() OVER (PARTITION BY l.run_id ORDER BY l.claimed_at DESC,l.id DESC) AS ordinal
		FROM office_launch_ledger l LEFT JOIN runs r ON r.id=l.run_id AND r.workspace_id=l.workspace_id
		WHERE l.run_id IN (?) AND (l.claimed_at=r.claimed_at OR r.id IS NULL) AND l.id<>'' AND length(l.id)<=256
	) SELECT run_id,claim_id,workspace_id,claimed_at FROM matching WHERE ordinal<=2 ORDER BY run_id,claim_id`, ids)
	if err != nil {
		return err
	}
	var rows []poolhistory.Selection
	if err := tx.SelectContext(ctx, &rows, tx.Rebind(query), args...); err != nil {
		return err
	}
	for _, row := range rows {
		history := owners[row.RunID]
		cleared := len(history.Clearances) == 1 && len(history.Runs) == 0
		if row.WorkspaceID != history.WorkspaceID || (!cleared &&
			(len(history.ClaimCounts) != 1 || history.ClaimCounts[0].CurrentMatches != 1)) {
			continue
		}
		if cleared && history.Selections[0].ClaimID != "" {
			continue
		}
		row.EntryID = history.Selections[0].EntryID
		history.Selections = []poolhistory.Selection{row}
	}
	return nil
}
