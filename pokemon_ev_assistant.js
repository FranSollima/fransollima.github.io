function get_ev_multiplier(){
	var macho_brace = document.getElementById('macho_brace_checkbox').checked;
	var horde = document.getElementById('horde_checkbox').checked;
	var ev_multiplier = 1;
	if(macho_brace) {ev_multiplier = ev_multiplier*2;};
	if(horde) {ev_multiplier = ev_multiplier*5;};
	return ev_multiplier
}
function update_colors(){
	var pokemon_buttons = document.getElementsByClassName('pokemon_button');
	var ev_multiplier = get_ev_multiplier();
	for (var i = pokemon_buttons.length - 1; i >= 0; i--) {
		//Missing EVs
		var hp_missing = document.getElementById('hp_obj').value-document.getElementById('hp_act').value;
		var atk_missing = document.getElementById('atk_obj').value-document.getElementById('atk_act').value;
		var def_missing = document.getElementById('def_obj').value-document.getElementById('def_act').value;
		var spa_missing = document.getElementById('spa_obj').value-document.getElementById('spa_act').value;
		var spd_missing = document.getElementById('spd_obj').value-document.getElementById('spd_act').value;
		var spe_missing = document.getElementById('spe_obj').value-document.getElementById('spe_act').value;

		if(ev_multiplier*parseInt(pokemon_buttons[i].getAttribute('hp')) > hp_missing){
			//HP
			pokemon_buttons[i].style.backgroundColor = 'indianred';
		} else if(ev_multiplier*parseInt(pokemon_buttons[i].getAttribute('atk')) > atk_missing){
			//ATK
			pokemon_buttons[i].style.backgroundColor = 'indianred';
		} else if(ev_multiplier*parseInt(pokemon_buttons[i].getAttribute('def')) > def_missing){
			//DEF
			pokemon_buttons[i].style.backgroundColor = 'indianred';
		} else if(ev_multiplier*parseInt(pokemon_buttons[i].getAttribute('spa')) > spa_missing){
			//SPA
			pokemon_buttons[i].style.backgroundColor = 'indianred';
		} else if(ev_multiplier*parseInt(pokemon_buttons[i].getAttribute('spd')) > spd_missing){
			//SPD
			pokemon_buttons[i].style.backgroundColor = 'indianred';
		} else if(ev_multiplier*parseInt(pokemon_buttons[i].getAttribute('spe')) > spe_missing){
			//SPE
			pokemon_buttons[i].style.backgroundColor = 'indianred';
		} else {
			pokemon_buttons[i].style.backgroundColor = 'lightgreen';
		};
	}
};
function display_pokemon(){
	document.getElementsByName(document.getElementById('pokemon_list').value)[0].style.display='block';
	document.getElementById('pokemon_list').value = '';
};
function complete_evs(){
	if(!document.getElementById('hp_act').value){ document.getElementById('hp_act').value = "0"};
	if(!document.getElementById('atk_act').value){ document.getElementById('atk_act').value = "0"};
	if(!document.getElementById('def_act').value){ document.getElementById('def_act').value = "0"};
	if(!document.getElementById('spa_act').value){ document.getElementById('spa_act').value = "0"};
	if(!document.getElementById('spd_act').value){ document.getElementById('spd_act').value = "0"};
	if(!document.getElementById('spe_act').value){ document.getElementById('spe_act').value = "0"};
	if(!document.getElementById('hp_obj').value){ document.getElementById('hp_obj').value = "0"};
	if(!document.getElementById('atk_obj').value){ document.getElementById('atk_obj').value = "0"};
	if(!document.getElementById('def_obj').value){ document.getElementById('def_obj').value = "0"};
	if(!document.getElementById('spa_obj').value){ document.getElementById('spa_obj').value = "0"};
	if(!document.getElementById('spd_obj').value){ document.getElementById('spd_obj').value = "0"};
	if(!document.getElementById('spe_obj').value){ document.getElementById('spe_obj').value = "0"};
}
function add_effort_values(pokemon){
	var ev_multiplier = get_ev_multiplier();
	if(confirm("Add EVs from "+pokemon.getAttribute("name")+"?")){
		complete_evs();
		document.getElementById('hp_act').value = parseInt(document.getElementById('hp_act').value) + ev_multiplier*parseInt(pokemon.getAttribute('hp'));
		document.getElementById('atk_act').value = parseInt(document.getElementById('atk_act').value) + ev_multiplier*parseInt(pokemon.getAttribute('atk'));
		document.getElementById('def_act').value = parseInt(document.getElementById('def_act').value) + ev_multiplier*parseInt(pokemon.getAttribute('def'));
		document.getElementById('spa_act').value = parseInt(document.getElementById('spa_act').value) + ev_multiplier*parseInt(pokemon.getAttribute('spa'));
		document.getElementById('spd_act').value = parseInt(document.getElementById('spd_act').value) + ev_multiplier*parseInt(pokemon.getAttribute('spd'));
		document.getElementById('spe_act').value = parseInt(document.getElementById('spe_act').value) + ev_multiplier*parseInt(pokemon.getAttribute('spe'));
		update_colors();
	}
};