{-# LANGUAGE CPP #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE RecordWildCards #-}
{-# LANGUAGE StandaloneDeriving #-}
{-# LANGUAGE TupleSections #-}

module Catalog
  ( ESStoreField(..)
  , CatalogStore(..)
  , Catalog(..)
  , takeCatalogField
  , Query(..)
  , fillQuery
  ) where

import           Control.Arrow ((&&&))
import           Control.Monad (unless)
import qualified Data.Aeson as J
import qualified Data.Aeson.Types as J
import           Data.Bits (xor)
import qualified Data.ByteString as BS
import qualified Data.HashMap.Strict as HM
import           Data.Semigroup (Semigroup((<>)))
import qualified Data.Text as T
import qualified Data.Text.Encoding as TE

import Monoid
import Field

data ESStoreField
  = ESStoreSource
  | ESStoreValues
  | ESStoreStore
  deriving (Eq, Ord, Enum, Show)

instance J.FromJSON ESStoreField where
  parseJSON J.Null                  = return ESStoreSource
  parseJSON (J.Bool False)          = return ESStoreValues
  parseJSON (J.Bool True)           = return ESStoreStore
  parseJSON (J.String "source")     = return ESStoreSource
  parseJSON (J.String "doc_values") = return ESStoreValues
  parseJSON (J.String "docvalue")   = return ESStoreValues
  parseJSON (J.String "value")      = return ESStoreValues
  parseJSON (J.String "store")      = return ESStoreStore
  parseJSON x = J.typeMismatch "ESStoreField" x

data CatalogStore
  = CatalogES
    { catalogIndex, catalogMapping :: !T.Text
    , catalogSettings :: J.Object
    , catalogStoreField :: !ESStoreField
    }
#ifdef HAVE_pgsql
  | CatalogPG
    { catalogTable :: !T.Text
    }
#endif

data Catalog = Catalog
  { catalogTitle :: !T.Text
  , catalogDescr :: Maybe T.Text
  , catalogStore :: !CatalogStore
  , catalogFieldGroups :: FieldGroups
  , catalogFields :: Fields
  , catalogFieldMap :: HM.HashMap T.Text Field
  , catalogKey :: Maybe T.Text
  }

instance J.FromJSON Catalog where
  parseJSON = J.withObject "catalog" $ \c -> do
    catalogFieldGroups <- c J..: "fields"
    catalogTitle <- c J..: "title"
    catalogDescr <- c J..:? "descr"
    catalogKey <- c J..:? "key"
    catalogStore <- CatalogES
        <$> (c J..: "index")
        <*> (c J..:! "mapping" J..!= "catalog")
        <*> (c J..:? "settings" J..!= HM.empty)
        <*> (c J..:? "store" J..!= ESStoreValues)
#ifdef HAVE_pgsql
      <|> CatalogPG
        <$> (c J..: "table")
#endif
    let catalogFields = expandFields catalogFieldGroups
        catalogFieldMap = HM.fromList $ map (fieldName &&& id) catalogFields
    mapM_ (\k -> unless (HM.member k catalogFieldMap) $ fail "key field not found in catalog") catalogKey
    return Catalog{..}

takeCatalogField :: T.Text -> Catalog -> Maybe (Field, Catalog)
takeCatalogField n c = (, c
  { catalogFieldMap    = HM.delete n                 $ catalogFieldMap c
  , catalogFields      = filter ((n /=) . fieldName) $ catalogFields c
  , catalogFieldGroups = deleteField n               $ catalogFieldGroups c
  }) <$> HM.lookup n (catalogFieldMap c) where

data Query = Query
  { queryOffset :: Word
  , queryLimit :: Word
  , querySort :: [(T.Text, Bool)]
  , queryFields :: [T.Text]
  , queryFilter :: [(T.Text, BS.ByteString, Maybe BS.ByteString)]
  , querySample :: Double
  , querySeed :: Maybe Word
  , queryAggs :: [T.Text]
  , queryHist :: Maybe (T.Text, BS.ByteString)
  }

instance Monoid Query where
  mempty = Query
    { queryOffset = 0
    , queryLimit  = 0
    , querySort   = []
    , queryFields = []
    , queryFilter = []
    , querySample = 1
    , querySeed   = Nothing
    , queryAggs   = []
    , queryHist   = Nothing
    }
  mappend = (<>)

instance Semigroup Query where
  q1 <> q2 = Query
    { queryOffset = queryOffset q1 +     queryOffset q2
    , queryLimit  = queryLimit  q1 `max` queryLimit  q2
    , querySort   = querySort   q1 <>    querySort   q2
    , queryFields = queryFields q1 <>    queryFields q2
    , queryFilter = queryFilter q1 <>    queryFilter q2
    , querySample = querySample q1 *     querySample q2
    , querySeed   = joinMaybeWith xor (querySeed q1) (querySeed q2)
    , queryAggs   = queryAggs   q1 <>    queryAggs   q2
    , queryHist   = queryHist   q1 <>    queryHist q2
    }

fillQuery :: Catalog -> Query -> Query
fillQuery cat q@Query{ queryFields = [] } = fillQuery cat $ q{ queryFields = map fieldName $ catalogFields cat }
fillQuery _ q = q

instance J.ToJSON Query where
  toJSON Query{..} = J.object
    [ "offset" J..= queryOffset
    , "limit"  J..= queryLimit
    , "sort"   J..= [ J.object
      [ "field" J..= f
      , "asc" J..= a
      ] | (f,a) <- querySort ]
    , "fields" J..= queryFields
    , "filter" J..= [ J.object
      [ "field" J..= f
      , "value" J..= maybe (bs a) (\b' -> J.object ["lb" J..= bs a, "ub" J..= bs b']) b
      ] | (f,a,b) <- queryFilter ]
    , "seed"   J..= querySeed
    , "sample" J..= querySample
    , "aggs"   J..= queryAggs
    , "hist"   J..= (fst <$> queryHist)
    ] where
    bs = J.String . TE.decodeLatin1

