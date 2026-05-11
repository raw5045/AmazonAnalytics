/**
 * Print the generated flat-predicate SQL so we can sanity-check it
 * before plugging into the backfill.
 */
import { looseMatchPredicate, looseTitleNormSql, looseSlotFlagSql } from '@/lib/analytics/loosePredicate';

console.log('=== looseTitleNormSql("kwm.top_clicked_product_1_title") ===\n');
console.log(looseTitleNormSql('kwm.top_clicked_product_1_title'));

console.log('\n=== looseMatchPredicate("r", "n1") ===\n');
console.log(looseMatchPredicate('r', 'n1'));

console.log('\n=== looseSlotFlagSql("kwm.top_clicked_product_1_title", "kwm.keyword_in_title_1", "r") ===\n');
console.log(looseSlotFlagSql('kwm.top_clicked_product_1_title', 'kwm.keyword_in_title_1', 'r'));
