package sqlite

import (
	"context"
	"encoding/json"

	"github.com/jmoiron/sqlx"
	"github.com/kandev/kandev/internal/task/poolhistory"
)

func (r *Repository) loadPoolHistorySelections(ctx context.Context, tx *sqlx.Tx, snapshot *poolhistory.Snapshot, query poolhistory.Query) error {
	seeds := poolhistory.SelectionSeeds(snapshot)
	encoded, err := json.Marshal(seeds)
	if err != nil {
		return err
	}
	var position poolhistory.Cursor
	if query.Position != nil {
		position = *query.Position
	}
	var claimedAt any
	if position.ClaimedAt != nil {
		claimedAt = position.ClaimedAt.UTC()
	}
	err = tx.SelectContext(ctx, &snapshot.Selections, tx.Rebind(`WITH selected AS (
		SELECT json_extract(value,'$.entry_id') AS entry_id,json_extract(value,'$.run_id') AS run_id FROM json_each(?)
	), attempts AS (
	SELECT s.entry_id,s.run_id,COALESCE(l.id,'') AS claim_id,
		COALESCE(l.workspace_id,'') AS workspace_id,l.claimed_at
	FROM selected s
	LEFT JOIN office_launch_ledger l ON l.run_id=s.run_id AND l.workspace_id=? AND l.id<>'' AND length(l.id)<=256
	UNION ALL SELECT s.entry_id,s.run_id,'' AS claim_id,r.workspace_id,NULL AS claimed_at
	FROM selected s JOIN runs r ON r.id=s.run_id AND r.workspace_id=? AND r.status='queued'
	WHERE EXISTS (SELECT 1 FROM office_launch_ledger prior WHERE prior.run_id=s.run_id AND prior.workspace_id=r.workspace_id)
	)
	SELECT l.entry_id,l.run_id,l.claim_id,l.workspace_id,native.claimed_at AS claimed_at FROM attempts l
	LEFT JOIN office_launch_ledger native ON native.id=l.claim_id AND native.run_id=l.run_id AND native.workspace_id=l.workspace_id
	WHERE ?=0 OR l.entry_id<? OR (l.entry_id=? AND (
		(?=1 AND l.claimed_at IS NULL) OR l.claimed_at<? OR
		((l.claimed_at=? OR (?=0 AND l.claimed_at IS NULL)) AND
		(l.run_id<? OR (l.run_id=? AND l.claim_id<?)))
	))
	ORDER BY l.entry_id DESC,l.claimed_at DESC,l.run_id DESC,l.claim_id DESC LIMIT ?`),
		string(encoded), snapshot.WorkspaceID, snapshot.WorkspaceID, query.Before, query.Before, query.Before,
		position.ClaimedAt != nil, claimedAt, claimedAt, position.ClaimedAt != nil, position.RunID, position.RunID, position.ClaimID, query.Limit+1)
	if err != nil {
		return err
	}
	if len(snapshot.Selections) > query.Limit {
		snapshot.HasMore = true
		snapshot.Selections = snapshot.Selections[:query.Limit]
	}
	return r.loadPoolHistoryClaimCounts(ctx, tx, snapshot, seeds)
}
