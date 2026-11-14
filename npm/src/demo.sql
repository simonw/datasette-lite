create table gardens (
  id integer primary key,
  name text not null,
  city text,
  latitude real,
  longitude real
);
create table plants (
  id integer primary key,
  common_name text not null,
  species text,
  garden_id integer references gardens(id),
  planted text,
  height_cm integer,
  edible integer
);
insert into gardens (id, name, city, latitude, longitude) values
  (1, 'Kitchen plot', 'Half Moon Bay', 37.4636, -122.4286),
  (2, 'Roof terrace', 'San Francisco', 37.7749, -122.4194),
  (3, 'Allotment 14', 'Brighton', 50.8225, -0.1372);
insert into plants (common_name, species, garden_id, planted, height_cm, edible) values
  ('Artichoke', 'Cynara cardunculus', 1, '2023-03-14', 140, 1),
  ('Meyer lemon', 'Citrus × meyeri', 1, '2021-05-02', 210, 1),
  ('Nasturtium', 'Tropaeolum majus', 1, '2024-04-20', 35, 1),
  ('Rosemary', 'Salvia rosmarinus', 2, '2022-02-11', 80, 1),
  ('Lavender', 'Lavandula angustifolia', 2, '2022-02-11', 60, 0),
  ('Fig', 'Ficus carica', 2, '2020-10-30', 250, 1),
  ('Runner bean', 'Phaseolus coccineus', 3, '2024-05-12', 220, 1),
  ('Rhubarb', 'Rheum rhabarbarum', 3, '2019-03-03', 90, 1),
  ('Foxglove', 'Digitalis purpurea', 3, '2023-06-18', 120, 0),
  ('Sweet pea', 'Lathyrus odoratus', 3, '2024-03-29', 180, 0);
