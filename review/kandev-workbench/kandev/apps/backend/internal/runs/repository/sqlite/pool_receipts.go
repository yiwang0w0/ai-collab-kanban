package sqlite

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jmoiron/sqlx"

	"github.com/kandev/kandev/internal/db/dialect"
	"github.com/kandev/kandev/internal/runs/models"
)

var (
	ErrPoolReceiptConflict = errors.New("pool_receipt_identity_conflict")
	ErrPoolReceiptUnknown  = errors.New("pool_receipt_evidence_unknown")
)

func (r *Repository) AppendPoolExecutionBinding(ctx context.Context, identity models.PoolExecutionIdentity) (*models.RunEvent, error) {
	return r.appendPoolReceipt(ctx, identity, "")
}

func (r *Repository) AppendPoolWorkObserved(
	ctx context.Context, identity models.PoolExecutionIdentity, source models.PoolStartSource,
) (*models.RunEvent, error) {
	switch source {
	case models.PoolStartCodexProvider, models.PoolStartAssistant, models.PoolStartTool:
		return r.appendPoolReceipt(ctx, identity, source)
	default:
		return nil, ErrPoolReceiptConflict
	}
}

func validPoolIdentity(identity models.PoolExecutionIdentity) bool {
	ids := []string{identity.RunID, identity.ClaimID, identity.TaskID, identity.AgentProfileID,
		identity.ExecutionProfileID, identity.SessionID, identity.ExecutionID, identity.TurnID, identity.OperationID}
	for _, id := range ids {
		if strings.TrimSpace(id) != id || id == "" || len(id) > 256 {
			return false
		}
	}
	if identity.OperationSource != "" && identity.OperationSource != models.PoolOperationProvider &&
		identity.OperationSource != models.PoolOperationHostTurn {
		return false
	}
	return identity.PromptGeneration > 0 && identity.ExecutionProfileID == identity.AgentProfileID &&
		(identity.OperationSource != models.PoolOperationHostTurn || identity.OperationID == identity.TurnID)
}

func (r *Repository) appendPoolReceipt(
	ctx context.Context, identity models.PoolExecutionIdentity, source models.PoolStartSource,
) (*models.RunEvent, error) {
	if !validPoolIdentity(identity) {
		return nil, ErrPoolReceiptConflict
	}
	// 首版只支持 SQLite；不能把未验收的存储行为当作已支持能力。
	if dialect.IsPostgres(r.db.DriverName()) {
		return nil, errors.New("pool_receipts_unsupported_storage")
	}
	tx, err := r.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	if err := r.lockPoolClaim(ctx, tx, identity); err != nil {
		return nil, err
	}
	event, err := r.writePoolReceipt(ctx, tx, identity, source)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return event, nil
}

func (r *Repository) lockPoolClaim(ctx context.Context, tx *sqlx.Tx, identity models.PoolExecutionIdentity) error {
	// 先取得写锁再读取身份，避免从过期读快照升级事务。
	res, err := tx.ExecContext(ctx, tx.Rebind(`UPDATE runs SET id = id WHERE id = ? AND status = 'claimed'`), identity.RunID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrPoolReceiptConflict
	}
	run, err := r.GetRunByIDTx(ctx, tx, identity.RunID)
	if err != nil {
		return err
	}
	var envelope struct {
		TaskID string `json:"task_id"`
	}
	if run.IdempotencyKey == nil || !strings.HasPrefix(*run.IdempotencyKey, models.PoolDispatchKeyPrefix) ||
		run.AgentProfileID != identity.AgentProfileID || run.ClaimedAt == nil ||
		json.Unmarshal([]byte(run.Payload), &envelope) != nil || envelope.TaskID != identity.TaskID {
		return ErrPoolReceiptConflict
	}
	claimID, err := currentPoolClaimID(ctx, tx, run)
	if err != nil {
		return err
	}
	if claimID != identity.ClaimID {
		return ErrPoolReceiptConflict
	}
	return nil
}

func (r *Repository) writePoolReceipt(
	ctx context.Context, tx *sqlx.Tx, identity models.PoolExecutionIdentity, source models.PoolStartSource,
) (*models.RunEvent, error) {
	bound, err := findPoolReceipt(ctx, tx, identity, models.PoolExecutionBound)
	if err != nil {
		return nil, err
	}
	if source == "" && bound != nil {
		return bound, nil
	}
	if source != "" {
		if bound == nil {
			return nil, ErrPoolReceiptUnknown
		}
		previous, err := findPoolReceipt(ctx, tx, identity, models.PoolWorkObserved)
		if err != nil || previous != nil {
			return previous, err
		}
	}
	if _, err := tx.ExecContext(ctx, tx.Rebind(`UPDATE runs SET session_id = ? WHERE id = ?`), identity.SessionID, identity.RunID); err != nil {
		return nil, err
	}
	kind := models.PoolExecutionBound
	var payload any = identity
	if source != "" {
		kind = models.PoolWorkObserved
		payload = models.PoolWorkReceipt{PoolExecutionIdentity: identity, StartedSource: source}
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	return insertPoolEvent(ctx, tx, identity.RunID, kind, string(encoded))
}

func findPoolReceipt(
	ctx context.Context, tx *sqlx.Tx, identity models.PoolExecutionIdentity, kind string,
) (*models.RunEvent, error) {
	var events []models.RunEvent
	if err := tx.SelectContext(ctx, &events, tx.Rebind(`
		SELECT run_id, seq, event_type, level, payload, created_at FROM run_events
		WHERE run_id = ? AND event_type = ? AND json_extract(payload, '$.claim_id') = ?
			ORDER BY seq LIMIT 2`), identity.RunID, kind, identity.ClaimID); err != nil {
		return nil, err
	}
	if len(events) > 1 {
		return nil, ErrPoolReceiptUnknown
	}
	if len(events) == 0 {
		return nil, nil
	}
	var stored models.PoolExecutionIdentity
	if err := json.Unmarshal([]byte(events[0].Payload), &stored); err != nil {
		return nil, fmt.Errorf("%w: invalid binding", ErrPoolReceiptUnknown)
	}
	if stored != identity {
		return nil, ErrPoolReceiptConflict
	}
	return &events[0], nil
}

func insertPoolEvent(ctx context.Context, tx *sqlx.Tx, runID, kind, payload string) (*models.RunEvent, error) {
	var seq int
	if err := tx.GetContext(ctx, &seq, tx.Rebind(`SELECT COALESCE(MAX(seq) + 1, 0) FROM run_events WHERE run_id = ?`), runID); err != nil {
		return nil, err
	}
	observed := time.Now().UTC()
	if _, err := tx.ExecContext(ctx, tx.Rebind(`
		INSERT INTO run_events (run_id, seq, event_type, level, payload, created_at)
		VALUES (?, ?, ?, 'info', ?, ?)`), runID, seq, kind, payload, observed); err != nil {
		return nil, err
	}
	return &models.RunEvent{RunID: runID, Seq: seq, EventType: models.RunEventType(kind),
		Level: models.RunEventLevelInfo, Payload: payload, CreatedAt: observed}, nil
}
