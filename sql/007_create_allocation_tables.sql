-- vw_AllocationCapped works correctly per-item but times out as a full weekly batch (~788
-- items x 144 stores): its correlated CROSS APPLY re-walks the whole vw_AllocationDraft view
-- chain (which itself joins several EBT views) for every one of the 113k output rows, and
-- SQL Server 2008 R2's optimizer doesn't push the ItemCode filter down into that efficiently.
--
-- Fix: materialize vw_AllocationDraft into a real table first (fast, ~1s, done once per run),
-- then compute the capped/final allocation against that flat table instead of the view stack.
-- A clustered index on (ItemCode, StoreCode) makes the per-item correlated subquery cheap.
CREATE TABLE AllocationDraft (
  ItemCode        nvarchar(8)  NOT NULL,
  ITEM_NO         decimal      NOT NULL,
  DCS_CODE        varchar(18)  NULL,
  DPS_Code        varchar(43)  NULL,
  QTY_PER_CASE    decimal      NULL,
  DC_Qty          int          NULL,
  StoreCode       varchar(50)  NOT NULL,
  StoreNo         int          NULL,
  DCSPattern      varchar(50)  NULL,
  StoreGroup      varchar(50)  NULL,
  BaseAllocationQty int        NOT NULL,
  AllowSend       char(1)      NOT NULL,
  OnHandQty       int          NOT NULL,
  InTransitQty    int          NOT NULL,
  AllocationQty   int          NOT NULL,
  CONSTRAINT PK_AllocationDraft PRIMARY KEY CLUSTERED (ItemCode, StoreCode)
);
GO

CREATE TABLE AllocationResults (
  ItemCode          nvarchar(8)  NOT NULL,
  ITEM_NO           decimal      NOT NULL,
  DCS_CODE          varchar(18)  NULL,
  DPS_Code          varchar(43)  NULL,
  QTY_PER_CASE      decimal      NULL,
  DC_Qty            int          NULL,
  StoreCode         varchar(50)  NOT NULL,
  StoreNo           int          NULL,
  DCSPattern        varchar(50)  NULL,
  StoreGroup        varchar(50)  NULL,
  BaseAllocationQty int          NOT NULL,
  AllowSend         char(1)      NOT NULL,
  OnHandQty         int          NOT NULL,
  InTransitQty      int          NOT NULL,
  AllocationQty     int          NOT NULL,
  GroupRank         int          NOT NULL,
  RunningTotal      int          NOT NULL,
  FinalAllocationQty int         NOT NULL,
  RunDate           datetime     NOT NULL DEFAULT GETDATE(),
  CONSTRAINT PK_AllocationResults PRIMARY KEY CLUSTERED (ItemCode, StoreCode)
);
GO
