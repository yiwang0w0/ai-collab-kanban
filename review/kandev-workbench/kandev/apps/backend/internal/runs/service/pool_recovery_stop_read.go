package service

import (
	"context"
	"errors"

	"github.com/jmoiron/sqlx"
	"github.com/kandev/kandev/internal/runs/models"
	runssqlite "github.com/kandev/kandev/internal/runs/repository/sqlite"
)

func poolRecoveryEvidenceConflict(err error) bool {
	return errors.Is(err, models.ErrPoolRecoveryConflict) || errors.Is(err, runssqlite.ErrPoolReceiptUnknown) || errors.Is(err, runssqlite.ErrPoolReceiptConflict)
}

func (s *Service) poolRecoveryReadStop(ctx context.Context, tx *sqlx.Tx, snapshot poolRecoveryRead, result *models.PoolRecoveryContext) error {
	_, admitted := s.poolEnqueueAdmission.(poolRecoveryStopAdmission)
	source, supported := s.poolReleaseSource.(poolRecoveryExecutionSource)
	if !admitted || !supported {
		result.Reason = "stop_unavailable"
		return nil
	}
	if result.ClaimID == "" || snapshot.run.FinishedAt != nil || snapshot.run.Outcome != nil {
		result.Reason = "stop_state_unverified"
		return nil
	}
	identity, err := s.repo.PoolRecoveryExecutionTx(ctx, tx, snapshot.run, result.ClaimID)
	if err == nil {
		var stopped bool
		stopped, err = s.repo.PoolRecoveryStopReceiptPresentTx(ctx, tx, snapshot.run.ID, result.ClaimID)
		if err == nil && stopped {
			result.Reason = "stop_recorded"
			return nil
		}
	}
	if err == nil {
		err = source.CheckPoolRecoveryExecutionTx(ctx, tx, identity)
	}
	if err != nil {
		if poolRecoveryEvidenceConflict(err) {
			result.Reason = "execution_binding_unverified"
			return nil
		}
		return err
	}
	result.Actions.Stop = true
	return nil
}
