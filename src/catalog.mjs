/**
 * Product + store catalog snapshot.
 *
 * Multi-product by construction: each product carries its own capacities, colors,
 * variants and launch timeline, because Apple ships them on different schedules
 * (iPhone 18 Pro Max released 2026-09-18; iPhone Duo pre-orders 2026-10-16).
 * A single global launch phase would gate one product on the other's dates.
 *
 * SKUs below are real CH/A part numbers read from Apple's own product payloads.
 * Never invent a part number: a wrong SKU resolves to `unknown` forever.
 */
export const catalog = {
  meta: {
    version: '2.3.0',
    market: 'CN',
    currency: 'CNY',
    locale: 'zh-CN',
    catalogVerifiedAt: '2026-09-12T21:00:00+08:00',
    storeListVerifiedAt: '2026-09-12T20:00:00+08:00'
  },
  defaultProduct: 'iphone-18-pro-max',
  products: {
    'iphone-18-pro-max': {
      id: 'iphone-18-pro-max',
      family: 'iPhone',
      name: 'iPhone 18 Pro Max',
      subtitle: '6.9 英寸 · A20 Pro',
      preorderAt: '2026-09-12T20:00:00+08:00',
      releaseAt: '2026-09-18T08:00:00+08:00',
      buyBase: 'https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/',
      capacities: ['256GB', '512GB', '1TB', '2TB'],
      colors: [
        { id: 'glacier-blue', label: '冰川蓝色', swatch: '#b7c5d8' },
        { id: 'burgundy', label: '勃艮第酒红色', swatch: '#5e3039' },
        { id: 'silver', label: '银色', swatch: '#e3e3e1' },
        { id: 'black', label: '黑色', swatch: '#2c2c2e' }
      ],
      variants: {
        '256GB:glacier-blue': { sku: 'MJY94CH/A', slug: 'mjy94ch/a', price: 10999 },
        '256GB:burgundy': { sku: 'MJY84CH/A', slug: 'mjy84ch/a', price: 10999 },
        '256GB:silver': { sku: 'MJY74CH/A', slug: 'mjy74ch/a', price: 10999 },
        '256GB:black': { sku: 'MJY64CH/A', slug: 'mjy64ch/a', price: 10999 },
        '512GB:black': { sku: 'MJYA4CH/A', slug: 'mjya4ch/a', price: 12999 },
        '512GB:glacier-blue': { sku: 'MJYE4CH/A', slug: 'mjye4ch/a', price: 12999 },
        '512GB:burgundy': { sku: 'MJYD4CH/A', slug: 'mjyd4ch/a', price: 12999 },
        '512GB:silver': { sku: 'MJYC4CH/A', slug: 'mjyc4ch/a', price: 12999 },
        '1TB:burgundy': { sku: 'MJYH4CH/A', slug: 'mjyh4ch/a', price: 16499 },
        '1TB:silver': { sku: 'MJYG4CH/A', slug: 'mjyg4ch/a', price: 16499 },
        '1TB:black': { sku: 'MJYF4CH/A', slug: 'mjyf4ch/a', price: 16499 },
        '1TB:glacier-blue': { sku: 'MJYJ4CH/A', slug: 'mjyj4ch/a', price: 16499 },
        '2TB:burgundy': { sku: 'MJYM4CH/A', slug: 'mjym4ch/a', price: 21499 },
        '2TB:silver': { sku: 'MJYL4CH/A', slug: 'mjyl4ch/a', price: 21499 },
        '2TB:black': { sku: 'MJYK4CH/A', slug: 'mjyk4ch/a', price: 21499 },
        '2TB:glacier-blue': { sku: 'MJYN4CH/A', slug: 'mjyn4ch/a', price: 21499 }
      }
    },
    'iphone-duo': {
      id: 'iphone-duo',
      family: 'iPhone',
      name: 'iPhone Duo',
      subtitle: '折叠设计 · 内外双屏',
      preorderAt: '2026-10-16T20:00:00+08:00',
      releaseAt: '2026-10-23T08:00:00+08:00',
      buyBase: 'https://www.apple.com.cn/shop/buy-iphone/iphone-duo/',
      capacities: ['256GB', '512GB', '1TB', '2TB'],
      colors: [
        { id: 'nightsky', label: '夜空色', swatch: '#343c47' },
        { id: 'starwhite', label: '星光白色', swatch: '#ecebe8' }
      ],
      variants: {
        '256GB:nightsky': { sku: 'MK2N4CH/A', slug: 'mk2n4ch/a', price: 15999 },
        '256GB:starwhite': { sku: 'MK2M4CH/A', slug: 'mk2m4ch/a', price: 15999 },
        '512GB:nightsky': { sku: 'MK2Q4CH/A', slug: 'mk2q4ch/a', price: 17999 },
        '512GB:starwhite': { sku: 'MK2P4CH/A', slug: 'mk2p4ch/a', price: 17999 },
        '1TB:nightsky': { sku: 'MK2U4CH/A', slug: 'mk2u4ch/a', price: 21499 },
        '1TB:starwhite': { sku: 'MK2T4CH/A', slug: 'mk2t4ch/a', price: 21499 },
        '2TB:nightsky': { sku: 'MK2W4CH/A', slug: 'mk2w4ch/a', price: 26499 },
        '2TB:starwhite': { sku: 'MK2V4CH/A', slug: 'mk2v4ch/a', price: 26499 }
      }
    }
  },
  regions: {
    beijing: region('北京', 'R320', 39.9042, 116.4074, [
      ['R320','三里屯'],['R388','西单大悦城'],['R448','王府井'],['R479','华贸购物中心'],['R645','朝阳大悦城'],['R792','北京荟聚']
    ]),
    shanghai: region('上海', 'R401', 31.2304, 121.4737, [
      ['R359','南京东路'],['R389','浦东'],['R390','香港广场'],['R401','上海环贸 iapm'],['R581','五角场'],['R678','静安'],['R683','环球港'],['R705','七宝']
    ]),
    shenzhen: region('深圳', 'R761', 22.5431, 114.0579, [['R484','深圳益田假日广场'],['R761','深圳万象城'],['R793','前海壹方城']]),
    guangzhou: region('广州', 'R577', 23.1291, 113.2644, [['R577','天环广场'],['R639','珠江新城']]),
    nanjing: region('南京', 'R493', 32.0603, 118.7969, [['R493','新街口'],['R643','虹悦城'],['R703','玄武湖']]),
    hangzhou: region('杭州', 'R471', 30.2741, 120.1551, [['R471','西湖'],['R532','杭州万象城']]),
    chengdu: region('成都', 'R580', 30.5728, 104.0668, [['R502','成都万象城'],['R580','成都太古里']]),
    chongqing: region('重庆', 'R480', 29.5630, 106.5516, [['R476','重庆北城天街'],['R480','解放碑'],['R573','重庆万象城']]),
    tianjin: region('天津', 'R579', 39.0842, 117.2009, [['R579','天津恒隆广场'],['R637','天津大悦城'],['R638','天津万象城']]),
    shenyang: region('沈阳', 'R534', 41.8057, 123.4315, [['R534','中街大悦城'],['R576','沈阳万象城']]),
    suzhou: region('苏州', 'R688', 31.2989, 120.5853, [['R688','苏州']]),
    wuxi: region('无锡', 'R574', 31.4912, 120.3119, [['R574','无锡恒隆广场']]),
    ningbo: region('宁波', 'R531', 29.8683, 121.5440, [['R531','天一广场']]),
    wenzhou: region('温州', 'R766', 27.9939, 120.6994, [['R766','温州万象城']]),
    qingdao: region('青岛', 'R557', 36.0671, 120.3826, [['R557','青岛万象城']]),
    jinan: region('济南', 'R648', 36.6512, 117.1201, [['R648','济南恒隆广场']]),
    hefei: region('合肥', 'R765', 31.8206, 117.2272, [['R765','合肥万象城']]),
    zhengzhou: region('郑州', 'R572', 34.7466, 113.6254, [['R572','郑州万象城']]),
    wuhan: region('武汉', 'R575', 30.5928, 114.3055, [['R575','武汉']]),
    changsha: region('长沙', 'R617', 28.2282, 112.9388, [['R617','长沙']]),
    xiamen: region('厦门', 'R644', 24.4798, 118.0894, [['R644','厦门新生活广场']]),
    fuzhou: region('福州', 'R646', 26.0745, 119.2965, [['R646','泰禾广场']]),
    dalian: region('大连', 'R609', 38.9140, 121.6147, [['R609','大连恒隆广场']]),
    kunming: region('昆明', 'R670', 25.0389, 102.7183, [['R670','昆明']]),
    nanning: region('南宁', 'R571', 22.8170, 108.3665, [['R571','南宁万象城']])
  }
};


function region(label, seedStore, lat, lon, storePairs) {
  return {
    label,
    seedStore,
    lat,
    lon,
    stores: storePairs.map(([id, name]) => ({ id, name }))
  };
}

export function getProduct(id) {
  return catalog.products[id || catalog.defaultProduct] ?? null;
}

export function getVariant(productId, capacity, color) {
  const product = getProduct(productId);
  return product?.variants[`${capacity}:${color}`] ?? null;
}

export function getRegion(id) {
  return catalog.regions[id] ?? null;
}

/** Every product id that lists a given SKU — used to label events and watches. */
export function productOfSku(sku) {
  for (const product of Object.values(catalog.products)) {
    if (Object.values(product.variants).some(v => v.sku === sku)) return product;
  }
  return null;
}

/**
 * Launch phase for one product. Products ship on independent schedules, so this is
 * never a global property of the catalog.
 */
export function launchPhase(productId, now = Date.now()) {
  const product = getProduct(productId);
  if (!product) return 'unknown';
  if (now < Date.parse(product.preorderAt)) return 'preorder-not-open';
  if (now < Date.parse(product.releaseAt)) return 'preorder-open';
  return 'released';
}
