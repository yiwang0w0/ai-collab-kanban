package retention

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/kandev/kandev/internal/db"
	"github.com/kandev/kandev/internal/db/dialect"
	"github.com/kandev/kandev/internal/runs/models"
)

// preservePoolHistory 必须先于任何删除；失败由调用者连同整个批次回滚。
func preservePoolHistory(ctx context.Context, tx *sqlx.Tx, ids []string) ([]models.PoolProjectionCommit, error) {
	if dialect.IsPostgres(tx.DriverName()) {
		return nil, nil
	}
	// 通知只是失效提示，每批最多 128 个不同任务；所有清理凭证仍完整落库。
	const maxNotifications = 128
	changes := make([]models.PoolProjectionCommit, 0)
	seen := make(map[string]struct{})
	for _, chunk := range chunkIDs(ids, retentionMaxHostParams) {
		bound, args, err := db.Bind(tx, `SELECT id,workspace_id,agent_profile_id,reason,status,idempotency_key,
			actor_kind,actor_id,coalesced_count,wake_wave_key,wake_wave_string,requested_at,
			CASE WHEN length(CAST(payload AS BLOB))<=16384 THEN payload ELSE '' END AS payload
			FROM runs WHERE id IN (?)`, chunk)
		if err != nil {
			return nil, err
		}
		var rows []*models.Run
		if err := tx.SelectContext(ctx, &rows, bound, args...); err != nil {
			return nil, err
		}
		for _, run := range rows {
			poolKey := run.IdempotencyKey != nil && strings.HasPrefix(*run.IdempotencyKey, models.PoolDispatchKeyPrefix)
			if !poolKey && run.Reason != models.PoolDispatchReason {
				continue
			}
			change, err := preservePoolRun(ctx, tx, run)
			if err != nil {
				return nil, err
			}
			if _, found := seen[change.TaskID]; !found && len(changes) < maxNotifications {
				seen[change.TaskID] = struct{}{}
				changes = append(changes, change)
			}
		}
	}
	return changes, nil
}

func preservePoolRun(ctx context.Context, tx *sqlx.Tx, run *models.Run) (models.PoolProjectionCommit, error) {
	release, valid := models.PoolReleaseForHistory(run)
	if !valid {
		return models.PoolProjectionCommit{}, errors.New("pool_history_clearance_binding_unverified")
	}
	encoded, err := json.Marshal(release)
	if err != nil {
		return models.PoolProjectionCommit{}, err
	}
	key, err := release.DispatchKey()
	if err != nil {
		return models.PoolProjectionCommit{}, err
	}
	_, err = tx.ExecContext(ctx, tx.Rebind(`INSERT INTO run_pool_history_clearances
		(dispatch_key,run_id,format_version,workspace_id,task_id,entry_id,release_json,requested_at,cleared_at)
		VALUES(?,?,1,?,?,?,?,?,?)`), key, run.ID, release.WorkspaceID, release.TaskID, release.EntryID,
		string(encoded), run.RequestedAt, time.Now().UTC())
	return models.PoolProjectionCommit{
		TaskID: release.TaskID, RunID: run.ID, Kind: models.PoolProjectionHistoryCleaned,
	}, err
}
