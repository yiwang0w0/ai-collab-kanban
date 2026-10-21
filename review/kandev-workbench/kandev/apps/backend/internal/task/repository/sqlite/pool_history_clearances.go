package sqlite

import (
	"context"

	"github.com/jmoiron/sqlx"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
)

func readPoolHistoryClearances(ctx context.Context, tx *sqlx.Tx, keys []string) ([]runsmodels.PoolHistoryClearance, error) {
	if len(keys) == 0 {
		return nil, nil
	}
	query, args, err := sqlx.In(`SELECT dispatch_key,run_id,format_version,workspace_id,task_id,entry_id,
		CASE WHEN length(CAST(release_json AS BLOB))<=16384 THEN release_json ELSE '' END AS release_json,
		requested_at,cleared_at FROM run_pool_history_clearances WHERE dispatch_key IN (?) LIMIT ?`, keys, len(keys))
	if err != nil {
		return nil, err
	}
	var rows []runsmodels.PoolHistoryClearance
	err = tx.SelectContext(ctx, &rows, tx.Rebind(query), args...)
	return rows, err
}
