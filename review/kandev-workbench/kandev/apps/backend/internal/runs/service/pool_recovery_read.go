package service

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/kandev/kandev/internal/db/dialect"
	"github.com/kandev/kandev/internal/runs/models"
	runssqlite "github.com/kandev/kandev/internal/runs/repository/sqlite"
)

type poolRecoveryRead struct {
	header  models.PoolRecoveryTaskHeader
	run     *models.Run
	release models.PoolReleaseSnapshot
}

func (s *Service) withPoolRecoveryRead(ctx context.Context, taskID, runID string, read func(context.Context, *sqlx.Tx, poolRecoveryRead) error) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if !poolRecoveryID(taskID) || !poolRecoveryID(runID) {
		return models.ErrPoolRecoveryInvalid
	}
	source, supported := s.poolReleaseSource.(poolRecoveryTaskSource)
	if !supported || dialect.IsPostgres(s.repo.Reader().DriverName()) {
		return models.ErrPoolAdmissionUnavailable
	}
	tx, err := s.repo.Reader().BeginTxx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	snapshot, err := s.loadPoolRecoverySnapshotTx(ctx, tx, source, taskID, runID)
	if err != nil {
		return err
	}
	if err := read(ctx, tx, snapshot); err != nil {
		return err
	}
	return tx.Commit()
}

func poolRecoveryID(value string) bool {
	return value != "" && len(value) <= 256 && strings.TrimSpace(value) == value
}

func (s *Service) GetPoolRecoveryContext(ctx context.Context, taskID, runID string) (*models.PoolRecoveryContext, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var result *models.PoolRecoveryContext
	var retryIdentity models.PoolExecutionIdentity
	err := s.withPoolRecoveryRead(ctx, taskID, runID, func(ctx context.Context, tx *sqlx.Tx, snapshot poolRecoveryRead) error {
		version, err := s.repo.PoolRecoveryRunVersionTx(ctx, tx, snapshot.run)
		if err != nil {
			return err
		}
		result = &models.PoolRecoveryContext{TaskID: taskID, RunID: runID, EntryID: snapshot.release.EntryID,
			TaskVersion: snapshot.header.Version, RunVersion: version, ManagementVersion: snapshot.header.ManagementVersion}
		if snapshot.run.ClaimedAt != nil {
			result.ClaimID, err = s.repo.PoolRecoveryClaimIDTx(ctx, tx, snapshot.run)
			if err != nil {
				if !errors.Is(err, runssqlite.ErrPoolReceiptUnknown) && !errors.Is(err, runssqlite.ErrPoolReceiptConflict) {
					return err
				}
				result.Reason = "claim_evidence_unknown"
				return nil
			}
		}
		if err := s.poolRecoveryReadActions(ctx, tx, snapshot, result); err != nil {
			return err
		}
		if snapshot.run.Status == models.RunStatusClaimed || snapshot.run.Status == models.RunStatusFinished {
			retryIdentity, err = s.poolRecoveryReadRetry(ctx, tx, snapshot, result)
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	s.probePoolRecoveryQuiescence(ctx, retryIdentity, result)
	return result, nil
}

func (s *Service) poolRecoveryReadActions(ctx context.Context, tx *sqlx.Tx, snapshot poolRecoveryRead, result *models.PoolRecoveryContext) error {
	actor, human := poolRecoveryHuman(ctx)
	if !human || s.poolEnqueueAdmission == nil {
		result.Reason = "human_confirmation_unavailable"
		return nil
	}
	if err := checkPoolRecoveryManager(snapshot.header, actor, result.ManagementVersion); err != nil {
		result.Reason = "management_conflict"
		return nil
	}
	if snapshot.run.Status == models.RunStatusClaimed {
		return s.poolRecoveryReadStop(ctx, tx, snapshot, result)
	}
	if err := s.repo.CheckPoolWithdrawalTx(ctx, tx, snapshot.run); err != nil {
		if err == models.ErrPoolRecoveryConflict {
			result.Reason = "withdrawal_not_eligible"
			return nil
		}
		return err
	}
	command := models.PoolRecoveryCommand{ExpectedTaskVersion: result.TaskVersion, ExpectedRunVersion: result.RunVersion}
	if err := s.validatePoolWithdrawalTx(ctx, tx, snapshot.header, snapshot.run, snapshot.release, command); err != nil {
		if err == models.ErrPoolRecoveryConflict {
			result.Reason = "release_changed"
			return nil
		}
		return err
	}
	result.Actions.Withdraw = true
	return nil
}

func (s *Service) GetPoolRecoveryOperation(ctx context.Context, taskID, runID, operationID string) (*models.RunEvent, error) {
	id, err := uuid.Parse(operationID)
	if err != nil || id == uuid.Nil || id.String() != operationID {
		return nil, models.ErrPoolRecoveryInvalid
	}
	var result *models.RunEvent
	err = s.withPoolRecoveryRead(ctx, taskID, runID, func(ctx context.Context, tx *sqlx.Tx, _ poolRecoveryRead) error {
		var err error
		result, err = s.repo.FindPoolRecoveryOperationTx(ctx, tx, runID, operationID)
		if err == nil && result == nil {
			return models.ErrPoolRecoveryNotFound
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}
