import config from '../../integration-users.config';
import * as helpers from '../../helpers';
import { Product, UserGroup } from 'ordercloud-javascript-sdk';
import { CosmosClient } from '@azure/cosmos';

/**
 *  Tasks:
 *  Add Product.xp.IsCollateralProduct = false
 *  Add xp.CollateralClassificationID to all salons (UserGroups). The classifications should match the salon types.
 *  Add Promotion.HasCollateralBundle = false
 */

const classificationsMap = {
  '20208': '20208',
  '20401': '20401',
  'Company Owned Institute': 'company-owned-institute',
  'Company Owned Salon/Spa': 'company-owned-salonspa',
  'Concept Salon': 'concept-salon',
  'Exclusive Destination Spa': 'exclusive-destination-spa',
  'Exclusive Salon': 'exclusive-salon',
  'Exclusive Spa': 'exclusive-spa',
  'Experience Center': 'experience-center',
  'Family Salon': 'family-salon',
  'Ind Lifestyle Store': 'ind-lifestyle-store',
  Institute: 'institute',
  'Lifestyle Salon': 'lifestyle-salon',
};

async function run() {
  const creds = config.prod.aveda;
  const sdk = await helpers.ocClient(creds.clientID, creds.clientSecret);
  const cosmos = new CosmosClient({
    endpoint: creds.cosmosEndpoint!,
    auth: { masterKey: creds.cosmosKey },
  });
  const cosmosContainer = cosmos
    .database(config.prod.aveda.cosmosDb!)
    .container('promotions');
  await updateProducts();
  await updateSalons();
  await updatePromos();

  async function updateProducts() {
    const errors = {};

    let products = await helpers.listAll<Product>(sdk.Products.List);
    products = products.filter(
      x => !x.xp || !x.xp.IsCollateralProduct
    );
    helpers.log(products);
    let progress = 0;
    const total = products.length;
    await helpers.batchOperations(products, async function singleOperation(
      product: Product
    ): Promise<any> {
      try {
        const xp = product.xp || {};
        xp.IsCollateralProduct = false;
        await sdk.Products.Patch(product.ID!, { xp });
        progress++;
        console.log(`${progress} of ${total} promotions done`);
      } catch (e) {
        errors[product.ID!] = e;
      }
    });
    helpers.log(errors, 'collateral-products');
  }

  async function updateSalons() {
    const errors = {};

    const buyers = await sdk.Buyers.List();
    const buyerID = buyers.Items![0].ID;
    let salons = await helpers.listAll<UserGroup>(
      sdk.UserGroups.List,
      buyerID,
      {
        filters: { ID: 'SoldTo*' },
      }
    );
    salons = salons.filter(
      x =>
        x.xp &&
        x.xp.Classification && // TODO - what about the 523 salons with no Classification?
        x.xp.CollateralClassificationID === undefined
    );
    helpers.log(salons);
    let progress = 0;
    const total = salons.length;
    await helpers.batchOperations(salons, async function singleOperation(
      salon: UserGroup
    ): Promise<any> {
      try {
        const xp = salon.xp || {};
        const classID = classificationsMap[xp.Classification];
        if (!classID) {
          errors[salon.ID!] = salon;
        } else {
          xp.CollateralClassificationID = classID;
          await sdk.UserGroups.Patch(buyerID!, salon.ID!, { xp });
          progress++;
          console.log(`${progress} of ${total} promotions done`);
        }
      } catch (e) {
        errors[salon.ID!] = e;
      }
    });
    helpers.log(errors, 'collateral-salons');
  }

  async function updatePromos() {
    const errors = {};

    const promotions = await cosmosContainer.items
      .query('SELECT * FROM root')
      .toArray();
    if (!promotions.result) {
      return;
    }
    const promosToUpdate = promotions.result.filter(
      x => x.HasCollateralBundle === undefined
    );
    helpers.log(promosToUpdate);
    let progress = 0;
    const total = promosToUpdate.length;
    for (let i = 0; i < total; i++) {
      const promo = promosToUpdate[i];
      promo.HasCollateralBundle = false;
      try {
        await cosmosContainer.item(promo.id).replace(promo);
        // Slowing things down prevents a 429 "Request rate is large" exception from Azure
        await new Promise(r => setTimeout(r, 100));
        progress++;
        console.log(`${progress} of ${total} promotions done`);
      } catch (e) {
        errors[promo.id] = e;
      }
    }
    helpers.log(errors, 'collateral-promos');
  }
}

run();
