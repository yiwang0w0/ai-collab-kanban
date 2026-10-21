package handlers

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/kandev/kandev/internal/task/poolhistory"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
	"github.com/kandev/kandev/internal/task/service"
	"go.uber.org/zap"
)

func (h *TaskHandlers) httpGetPoolHistory(c *gin.Context) {
	limit := 0
	if raw := c.Query("limit"); raw != "" {
		var err error
		limit, err = strconv.Atoi(raw)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"code": "pool_history_invalid_query"})
			return
		}
	}
	page, err := h.service.GetPoolHistory(c.Request.Context(), c.Param("id"), limit, c.Query("cursor"))
	switch {
	case err == nil:
		c.JSON(http.StatusOK, page)
	case errors.Is(err, poolhistory.ErrInvalidQuery):
		c.JSON(http.StatusBadRequest, gin.H{"code": "pool_history_invalid_query"})
	case errors.Is(err, repoerrors.ErrTaskNotFound), errors.Is(err, repoerrors.ErrWorkspaceNotFound):
		c.JSON(http.StatusNotFound, gin.H{"code": "task_not_found"})
	case service.IsForbidden(err):
		c.JSON(http.StatusForbidden, gin.H{"code": "forbidden"})
	default:
		h.logger.Error("pool history read failed", zap.Error(err))
		c.JSON(http.StatusServiceUnavailable, gin.H{"code": "pool_history_unavailable"})
	}
}
