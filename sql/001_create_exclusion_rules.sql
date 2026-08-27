-- Metadata for the 12 exclusion rules formerly maintained in Access.
-- IsActive lets a rule be toggled off without touching the evaluation logic.
CREATE TABLE ExclusionRules (
  RuleCode    varchar(10)   NOT NULL PRIMARY KEY,
  RuleName    varchar(100)  NOT NULL,
  Description varchar(1000) NULL,
  IsActive    bit           NOT NULL DEFAULT 1,
  ModifiedDate datetime     NOT NULL DEFAULT GETDATE()
);
GO

INSERT INTO ExclusionRules (RuleCode, RuleName, Description) VALUES
('Exc1',  'Store closed',                        'Block stores where Store Directory.WStoreType is empty - an empty WStoreType means the store is closed.'),
('Exc2',  'EBT store = N',                        'Block stores other than 470 from items not flagged as EBT (retail) store items.'),
('Exc3',  'Online store = N',                     'Block store 470 (online) from items not flagged as online store items.'),
('Exc4',  'MarkdownFlag = Y',                     'Block markdown items from IttyBitty/XSm stores, Fashion Focus stores, store 479, and stores open less than 60 days.'),
('Exc5',  'Prop 65 = Fail',                       'Block CA stores and store 470 from items that failed Prop 65.'),
('Exc6',  'Canvas wall art',                      'Block IttyBitty/XSm stores from HD WD canvas items.'),
('Exc7',  'Curtains',                             'Block IttyBitty stores and stores 420/485 from HD WD AC curtain items.'),
('Exc8',  'Large statue',                         'Block IttyBitty stores from items 0 and 10731.'),
('Exc9',  'Sunglasses',                           'Block CA stores and store 470 from AC WO SU items.'),
('Exc10', 'Fashion Focus Store status',           'Items flagged IStatus = FashionFocusStore only ship to Fashion Focus stores or stores 376/470.'),
('Exc11', 'Fashion Focus block entire DCS',       'Block Fashion Focus stores and store 479 from a fixed list of DCS codes entirely.'),
('Exc12', 'Fashion Focus block DCS with exceptions', 'Block Fashion Focus stores and store 479 from specific DCS codes, with per-DCS item/vendor/description exceptions.');
GO
