create table items (id integer primary key, name text, qty integer, price real, note text default 'from-sql');
create table setup_marker (value text);
insert into setup_marker values ('setup ran');
