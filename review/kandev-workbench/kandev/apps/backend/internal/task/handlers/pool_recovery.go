package handlers

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
	"github.com/kandev/kandev/internal/task/service"
	"go.uber.org/zap"
)

func (h *TaskHandlers) httpGetPoolRecovery(c *gin.Context) {
	result, err := h.service.GetPoolRecoveryContext(c.Request.Context(), c.Param("id"), c.Query("run_id"))
	if err != nil {
		h.poolRecoveryError(c, err)
		return
	}
	c.JSON(http.StatusOK, result)
}

func (h *TaskHandlers) httpRecoverPoolRun(c *gin.Context) {
	var command runsmodels.PoolRecoveryCommand
	decoder := json.NewDecoder(http.MaxBytesReader(c.Writer, c.Request.Body, 16384))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&command); err != nil {
		h.poolRecoveryError(c, runsmodels.ErrPoolRecoveryInvalid)
		return
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		h.poolRecoveryError(c, runsmodels.ErrPoolRecoveryInvalid)
		return
	}
	event, err := h.service.RecoverPoolRun(c.Request.Context(), c.Param("id"), command)
	h.poolRecoveryResponse(c, event, c.Param("id"), command.RunID, command.OperationID, err)
}

func (h *TaskHandlers) httpGetPoolRecoveryOperation(c *gin.Context) {
	event, err := h.service.GetPoolRecoveryOperation(c.Request.Context(), c.Param("id"), c.Query("run_id"), c.Param("operation_id"))
	h.poolRecoveryResponse(c, event, c.Param("id"), c.Query("run_id"), c.Param("operation_id"), err)
}

func (h *TaskHandlers) poolRecoveryResponse(c *gin.Context, event *runsmodels.RunEvent, taskID, runID, operationID string, err error) {
	if err != nil {
		h.poolRecoveryError(c, err)
		return
	}
	var operation runsmodels.PoolRecoveryOperation
	if event == nil || event.RunID != runID || event.Seq < 0 ||
		event.CreatedAt.IsZero() || json.Unmarshal([]byte(event.Payload), &operation) != nil ||
		operation.TaskID != taskID || operation.Command.RunID != runID || operation.Command.OperationID != operationID ||
		!operation.Command.Valid() || !poolRecoveryReceiptMatches(event.EventType, operation) {
		h.poolRecoveryError(c, runsmodels.ErrPoolAdmissionUnavailable)
		return
	}
	c.JSON(http.StatusOK, runsmodels.PoolRecoveryResult{OperationID: operationID, Action: operation.Command.Action,
		TaskID: taskID, RunID: runID, ClaimID: operation.Command.ExpectedClaimID, Result: operation.Result,
		RecordedAt: event.CreatedAt, EventSeq: event.Seq})
}

func poolRecoveryReceiptMatches(kind runsmodels.RunEventType, operation runsmodels.PoolRecoveryOperation) bool {
	switch operation.Command.Action {
	case "withdraw":
		return kind == runsmodels.PoolRecoveryWithdrawn && operation.Result == "withdrawn"
	case "stop":
		return kind == runsmodels.PoolRecoveryStopRequested && operation.Result == "stop_requested"
	case "retry":
		return kind == runsmodels.PoolRecoveryRequeued && operation.Result == "requeued"
	default:
		return false
	}
}

func (h *TaskHandlers) poolRecoveryError(c *gin.Context, err error) {
	status, code := http.StatusServiceUnavailable, "pool_recovery_unavailable"
	switch {
	case errors.Is(err, runsmodels.ErrPoolRecoveryInvalid):
		status, code = http.StatusBadRequest, "pool_recovery_invalid_request"
	case errors.Is(err, runsmodels.ErrPoolRecoveryConfirmation):
		status, code = http.StatusConflict, "pool_recovery_human_confirmation_required"
	case errors.Is(err, runsmodels.ErrPoolRecoveryConflict), errors.Is(err, runsmodels.ErrPoolTaskStartPreparing):
		status, code = http.StatusConflict, "pool_recovery_version_conflict"
	case errors.Is(err, runsmodels.ErrPoolRecoveryNotFound), errors.Is(err, sql.ErrNoRows),
		errors.Is(err, repoerrors.ErrTaskNotFound), errors.Is(err, repoerrors.ErrWorkspaceNotFound):
		status, code = http.StatusNotFound, "pool_recovery_not_found"
	case service.IsForbidden(err):
		status, code = http.StatusForbidden, "forbidden"
	default:
		h.logger.Error("pool recovery unavailable", zap.Error(err))
	}
	c.JSON(status, gin.H{"code": code})
}
