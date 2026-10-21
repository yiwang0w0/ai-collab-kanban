package handlers

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/kandev/kandev/internal/task/poolview"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
	"github.com/kandev/kandev/internal/task/service"
	"go.uber.org/zap"
)

func (h *TaskHandlers) httpGetPoolProjection(c *gin.Context) {
	limit := 0
	if raw := c.Query("limit"); raw != "" {
		var err error
		limit, err = strconv.Atoi(raw)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"code": "pool_projection_invalid_query"})
			return
		}
	}
	page, err := h.service.GetPoolProjection(c.Request.Context(), c.Param("id"), limit, c.Query("cursor"))
	switch {
	case err == nil:
		c.JSON(http.StatusOK, page)
	case errors.Is(err, poolview.ErrInvalidQuery):
		c.JSON(http.StatusBadRequest, gin.H{"code": "pool_projection_invalid_query"})
	case errors.Is(err, repoerrors.ErrWorkspaceNotFound):
		c.JSON(http.StatusNotFound, gin.H{"code": "workspace_not_found"})
	case service.IsForbidden(err):
		c.JSON(http.StatusForbidden, gin.H{"code": "forbidden"})
	default:
		h.logger.Error("任务池列表读取失败", zap.Error(err))
		c.JSON(http.StatusServiceUnavailable, gin.H{"code": "pool_projection_unavailable"})
	}
}
