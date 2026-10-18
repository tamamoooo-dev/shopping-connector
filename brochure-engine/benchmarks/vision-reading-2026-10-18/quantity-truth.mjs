// Secondary practical denominator audit, authored from pixels before held-out inference.
// Development labels reuse the earlier image audit; fresh labels below are new.
// Ambiguous totals, product specifications and count/mass ambiguity are excluded.
import {readFileSync} from 'node:fs';
const previous=JSON.parse(readFileSync(new URL('../resource-release-2026-10-18/implementation-holdout-truth.json',import.meta.url),'utf8'));
export const quantityTruth=[...previous.samples.map(t=>({index:t.index,unit:t.unit??null,reference:t.reference??null,excluded:t.exclude??null})),
 ...[
 [33,'kg',.108],[34,'l',2.9],[35,null,null,'Footwear'],[36,'l',1],[37,'kg',.1],[38,null,null,'Speaker'],
 [39,'kg',.16],[40,'kg',1.8],[41,'l',2.25],[42,'kg',.19],[43,null,null,'Doll'],[44,'pcs',72],
 [45,'kg',.45],[46,'pcs',12],[47,null,null,'Age labels; no explicit sale count'],[48,'kg',.465],
 [49,'kg',.7],[50,'pcs',12],[51,null,null,'Tablet specifications'],[52,'kg',.5],
 [53,null,null,'Blender'],[54,null,null,'TV'],[55,'kg',10],[56,'kg',1],
 [57,null,null,'12x40g plus 12+2 free badge: ambiguous whether 12 includes bonus'],[58,'kg',.165],
 [59,'pcs',2],[60,null,null,'Alternative 900g and 1000g products'],[61,'kg',.4],[62,'l',.473],[63,'kg',.19],[64,'kg',10],
 ].map(([index,unit,reference,excluded=null])=>({index,unit,reference,excluded}))];
